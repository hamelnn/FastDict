import Tauri
import UIKit
import WebKit
import PhotosUI
import ImageIO
import UniformTypeIdentifiers

private struct ShareArgs: Decodable { let text: String }
private struct PickedImage: Encodable { let dataUrl: String; let width: Int; let height: Int }
private struct ImageResponse: Encodable { let image: PickedImage? }

class FastDictMobilePlugin: Plugin, PHPickerViewControllerDelegate, UIAdaptivePresentationControllerDelegate {
    private weak var webView: WKWebView?
    private var imageInvoke: Invoke?
    private var processingImage = false
    private let maxBytes = 20 * 1024 * 1024

    @objc public override func load(webview: WKWebView) { webView = webview }

    private func presenter() -> UIViewController? {
        var controller = webView?.window?.rootViewController
        while let presented = controller?.presentedViewController { controller = presented }
        return controller
    }

    @objc public func pickImage(_ invoke: Invoke) {
        DispatchQueue.main.async {
            guard self.imageInvoke == nil, !self.processingImage else { invoke.reject("请先完成当前图片选择"); return }
            guard let controller = self.presenter() else { invoke.reject("主窗口暂不可用"); return }
            // PHPicker gives temporary access to the selected image only. It
            // deliberately does not request access to the user's photo library.
            var config = PHPickerConfiguration()
            config.filter = .images
            config.selectionLimit = 1
            config.preferredAssetRepresentationMode = .current
            let picker = PHPickerViewController(configuration: config)
            picker.delegate = self
            picker.presentationController?.delegate = self
            self.imageInvoke = invoke
            controller.present(picker, animated: true)
        }
    }

    func presentationControllerDidDismiss(_ presentationController: UIPresentationController) {
        // Interactive sheet dismissal must also release the pending Rust call.
        if let invoke = imageInvoke {
            imageInvoke = nil
            invoke.resolve(ImageResponse(image: nil))
        }
    }

    func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
        picker.dismiss(animated: true)
        guard let invoke = imageInvoke else { return }
        imageInvoke = nil
        guard let provider = results.first?.itemProvider else {
            invoke.resolve(ImageResponse(image: nil))
            return
        }
        processingImage = true
        // A temporary file avoids allocating an unbounded HEIC/RAW representation.
        // ImageIO applies EXIF orientation and decodes only the OCR-sized image.
        provider.loadFileRepresentation(forTypeIdentifier: UTType.image.identifier) { url, _ in
            defer { DispatchQueue.main.async { self.processingImage = false } }
            guard let url = url else { invoke.reject("无法读取所选图片，请重试"); return }
            do {
                let handle = try FileHandle(forReadingFrom: url)
                defer { try? handle.close() }
                let data = try handle.read(upToCount: self.maxBytes + 1) ?? Data()
                guard data.count <= self.maxBytes else {
                    invoke.reject("图片过大，请选择 20 MB 以内的截图或先裁剪"); return
                }
                guard let source = CGImageSourceCreateWithData(data as CFData, [kCGImageSourceShouldCache: false] as CFDictionary),
                      let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
                      let width = properties[kCGImagePropertyPixelWidth] as? NSNumber,
                      let height = properties[kCGImagePropertyPixelHeight] as? NSNumber,
                      width.doubleValue > 0, height.doubleValue > 0,
                      width.doubleValue * height.doubleValue <= 80_000_000 else {
                    invoke.reject("图片尺寸过大或格式不支持，请先裁剪截图"); return
                }
                let options: [CFString: Any] = [
                    kCGImageSourceCreateThumbnailFromImageAlways: true,
                    kCGImageSourceCreateThumbnailWithTransform: true,
                    kCGImageSourceThumbnailMaxPixelSize: 4096,
                    kCGImageSourceShouldCacheImmediately: true
                ]
                guard let cgImage = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary),
                      let png = UIImage(cgImage: cgImage).pngData(), png.count <= self.maxBytes else {
                    invoke.reject("图片尺寸过大或格式不支持，请先裁剪截图"); return
                }
                invoke.resolve(ImageResponse(image: PickedImage(
                    dataUrl: "data:image/png;base64," + png.base64EncodedString(),
                    width: cgImage.width, height: cgImage.height
                )))
            } catch { invoke.reject("无法读取所选图片，请重试") }
        }
    }

    @objc public func shareText(_ invoke: Invoke) throws {
        let args = try invoke.parseArgs(ShareArgs.self)
        guard !args.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              args.text.count <= 100_000 else { invoke.reject("请先生成译文"); return }
        DispatchQueue.main.async {
            guard self.imageInvoke == nil, !self.processingImage, let controller = self.presenter(), let view = self.webView else {
                invoke.reject("请先关闭当前系统弹窗"); return
            }
            let share = UIActivityViewController(activityItems: [args.text], applicationActivities: nil)
            // A popover anchor is mandatory on iPad.
            share.popoverPresentationController?.sourceView = view
            share.popoverPresentationController?.sourceRect = CGRect(x: view.bounds.midX, y: view.bounds.midY, width: 1, height: 1)
            share.popoverPresentationController?.permittedArrowDirections = []
            controller.present(share, animated: true) { invoke.resolve() }
        }
    }
}

@_cdecl("init_plugin_fastdict_mobile")
public func initPlugin() -> Plugin { FastDictMobilePlugin() }
