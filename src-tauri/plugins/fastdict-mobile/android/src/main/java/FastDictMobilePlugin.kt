package app.fastdict.mobile

import android.app.Activity
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.AtomicFile
import android.util.Base64
import androidx.activity.result.ActivityResult
import androidx.exifinterface.media.ExifInterface
import app.tauri.annotation.ActivityCallback
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.File
import java.security.KeyStore
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import org.json.JSONObject

@InvokeArg
class ShareArgs { lateinit var text: String }

@InvokeArg
class KeyArgs {
    lateinit var providerId: String
    var apiKey: String? = null
}

@TauriPlugin
class FastDictMobilePlugin(private val activity: Activity) : Plugin(activity) {
    private val imageWorker = Executors.newSingleThreadExecutor()
    private val vaultWorker = Executors.newSingleThreadExecutor()
    private val picking = AtomicBoolean(false)
    private val maxBytes = 20 * 1024 * 1024

    @Command
    fun pickImage(invoke: Invoke) {
        if (!picking.compareAndSet(false, true)) {
            invoke.reject("请先完成当前图片选择")
            return
        }
        try {
            // The grant covers only the selected document. No storage or photo
            // library permission, persistent URI grant or background access.
            val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
                addCategory(Intent.CATEGORY_OPENABLE)
                type = "image/*"
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }
            startActivityForResult(invoke, intent, "imageSelected")
        } catch (_: Exception) {
            picking.set(false)
            invoke.reject("无法打开系统图片选择器")
        }
    }

    @ActivityCallback
    private fun imageSelected(invoke: Invoke, result: ActivityResult) {
        val uri = result.data?.data
        if (result.resultCode != Activity.RESULT_OK || uri == null) {
            picking.set(false)
            invoke.resolve(JSObject().apply { put("image", JSONObject.NULL) })
            return
        }
        imageWorker.execute {
            try {
                val bytes = activity.contentResolver.openInputStream(uri)?.use { input ->
                    val output = ByteArrayOutputStream()
                    val buffer = ByteArray(8192)
                    while (true) {
                        val count = input.read(buffer)
                        if (count < 0) break
                        if (output.size() + count > maxBytes) throw ImageTooLarge()
                        output.write(buffer, 0, count)
                    }
                    output.toByteArray()
                } ?: throw IllegalArgumentException()
                val image = decodeImage(bytes)
                invoke.resolve(JSObject().apply { put("image", image) })
            } catch (_: ImageTooLarge) {
                invoke.reject("图片过大，请选择 20 MB 以内的截图或先裁剪")
            } catch (_: Exception) {
                invoke.reject("无法读取这张图片，请选择 PNG、JPEG 或 WebP 截图")
            } catch (_: OutOfMemoryError) {
                invoke.reject("图片尺寸过大，请先裁剪截图")
            } finally {
                picking.set(false)
            }
        }
    }

    private class ImageTooLarge : Exception()

    private fun decodeImage(bytes: ByteArray): JSObject {
        val options = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size, options)
        require(options.outWidth > 0 && options.outHeight > 0)
        if (options.outWidth.toLong() * options.outHeight > 80_000_000L) throw ImageTooLarge()
        options.inJustDecodeBounds = false
        options.inSampleSize = 1
        while (maxOf(options.outWidth, options.outHeight) / options.inSampleSize > 4096) {
            options.inSampleSize *= 2
        }
        var bitmap = BitmapFactory.decodeByteArray(bytes, 0, bytes.size, options)
            ?: throw IllegalArgumentException()
        try {
            val orientation = try {
                ExifInterface(ByteArrayInputStream(bytes))
                    .getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL)
            } catch (_: Exception) { ExifInterface.ORIENTATION_NORMAL }
            val matrix = Matrix()
            when (orientation) {
                ExifInterface.ORIENTATION_FLIP_HORIZONTAL -> matrix.setScale(-1f, 1f)
                ExifInterface.ORIENTATION_ROTATE_180 -> matrix.setRotate(180f)
                ExifInterface.ORIENTATION_FLIP_VERTICAL -> matrix.setScale(1f, -1f)
                ExifInterface.ORIENTATION_TRANSPOSE -> { matrix.setRotate(90f); matrix.postScale(-1f, 1f) }
                ExifInterface.ORIENTATION_ROTATE_90 -> matrix.setRotate(90f)
                ExifInterface.ORIENTATION_TRANSVERSE -> { matrix.setRotate(270f); matrix.postScale(-1f, 1f) }
                ExifInterface.ORIENTATION_ROTATE_270 -> matrix.setRotate(270f)
            }
            if (!matrix.isIdentity) {
                val oriented = Bitmap.createBitmap(bitmap, 0, 0, bitmap.width, bitmap.height, matrix, true)
                if (oriented !== bitmap) { bitmap.recycle(); bitmap = oriented }
            }
            val output = ByteArrayOutputStream()
            check(bitmap.compress(Bitmap.CompressFormat.PNG, 100, output))
            if (output.size() > maxBytes) throw ImageTooLarge()
            return JSObject().apply {
                put("dataUrl", "data:image/png;base64," + Base64.encodeToString(output.toByteArray(), Base64.NO_WRAP))
                put("width", bitmap.width)
                put("height", bitmap.height)
            }
        } finally { bitmap.recycle() }
    }

    @Command
    fun shareText(invoke: Invoke) {
        try {
            val text = invoke.parseArgs(ShareArgs::class.java).text
            require(text.isNotBlank() && text.length <= 100_000)
            val send = Intent(Intent.ACTION_SEND).apply {
                type = "text/plain"
                putExtra(Intent.EXTRA_TEXT, text)
            }
            activity.startActivity(Intent.createChooser(send, "分享译文"))
            // Android confirms that the chooser opened, not successful delivery.
            invoke.resolve()
        } catch (_: Exception) { invoke.reject("无法打开系统分享菜单") }
    }

    @Command
    fun saveKey(invoke: Invoke) = vaultOperation(invoke) { args ->
        val secret = requireNotNull(args.apiKey)
        require(secret.isNotBlank() && secret.toByteArray(Charsets.UTF_8).size <= 4096)
        require(secret.none { it == '\u0000' || it == '\r' || it == '\n' })
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, vaultKey())
        cipher.updateAAD(args.providerId.toByteArray(Charsets.UTF_8))
        val encrypted = cipher.doFinal(secret.toByteArray(Charsets.UTF_8))
        val record = JSONObject().apply {
            put("v", 1)
            put("iv", Base64.encodeToString(cipher.iv, Base64.NO_WRAP))
            put("data", Base64.encodeToString(encrypted, Base64.NO_WRAP))
        }.toString().toByteArray(Charsets.UTF_8)
        val target = keyFile(args.providerId)
        val stream = target.startWrite()
        try { stream.write(record); target.finishWrite(stream) }
        catch (error: Exception) { target.failWrite(stream); throw error }
        invoke.resolve()
    }

    @Command
    fun getKey(invoke: Invoke) = vaultOperation(invoke) { args ->
        val file = keyFile(args.providerId)
        val recordBytes = try { file.readFully() } catch (_: java.io.FileNotFoundException) { null }
        if (recordBytes == null) {
            invoke.resolve(JSObject().apply { put("key", JSONObject.NULL) })
        } else {
            require(recordBytes.size <= 8192)
            val record = JSONObject(String(recordBytes, Charsets.UTF_8))
            require(record.getInt("v") == 1)
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, vaultKey(), GCMParameterSpec(128, Base64.decode(record.getString("iv"), Base64.NO_WRAP)))
            cipher.updateAAD(args.providerId.toByteArray(Charsets.UTF_8))
            val value = cipher.doFinal(Base64.decode(record.getString("data"), Base64.NO_WRAP))
            invoke.resolve(JSObject().apply { put("key", String(value, Charsets.UTF_8)) })
        }
    }

    @Command
    fun deleteKey(invoke: Invoke) = vaultOperation(invoke) { args ->
        val file = keyFile(args.providerId)
        file.delete()
        check(!file.baseFile.exists())
        invoke.resolve()
    }

    private fun vaultOperation(invoke: Invoke, block: (KeyArgs) -> Unit) {
        val args = try {
            invoke.parseArgs(KeyArgs::class.java).also {
                require(it.providerId.matches(Regex("[A-Za-z0-9_-]{1,128}")))
            }
        } catch (_: Exception) { invoke.reject("API 配置标识无效"); return }
        vaultWorker.execute {
            try { block(args) }
            catch (_: Exception) { invoke.reject("设备密钥存储暂不可用，请重新保存 API Key") }
        }
    }

    private fun keyFile(providerId: String): AtomicFile {
        // The wrapping key cannot leave Android Keystore. Ciphertext is kept
        // outside Auto Backup so a device restore never restores unusable keys.
        val directory = File(activity.noBackupFilesDir, "fastdict-vault")
        check(directory.isDirectory || directory.mkdirs())
        return AtomicFile(File(directory, "$providerId.enc"))
    }

    private fun vaultKey(): SecretKey {
        val alias = "app.fastdict.api-keys.v1"
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey(alias, null) as? SecretKey)?.let { return it }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").run {
            init(KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .setRandomizedEncryptionRequired(true)
                .build())
            generateKey()
        }
    }
}
