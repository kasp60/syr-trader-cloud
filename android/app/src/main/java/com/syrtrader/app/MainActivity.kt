package com.syrtrader.app

import android.app.Activity
import android.graphics.Color
import android.graphics.Typeface
import android.os.Bundle
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.nio.ByteBuffer
import java.security.KeyStore
import java.util.concurrent.Executors
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

class MainActivity : Activity() {
    private val baseUrl = "https://syr-trader-cloud.kamalkhtib1.workers.dev"
    private val origin = baseUrl
    private val navy = Color.rgb(8, 15, 28)
    private val panel = Color.rgb(17, 28, 46)
    private val teal = Color.rgb(35, 190, 170)
    private val muted = Color.rgb(160, 174, 195)
    private val executor = Executors.newSingleThreadExecutor()
    private lateinit var root: LinearLayout
    private lateinit var status: TextView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.statusBarColor = navy
        window.navigationBarColor = navy
        showLoading("جارٍ التحقق من الجلسة...")
        val savedCookie = readSession()
        if (savedCookie.isNullOrBlank()) showLogin() else {
            executor.execute {
                try {
                    val profile = request("GET", "/api/auth/me", null, savedCookie)
                    runOnUiThread { showDashboard(profile, savedCookie) }
                } catch (e: Exception) {
                    clearSession()
                    runOnUiThread { showLogin(e.message ?: "انتهت الجلسة، سجّل الدخول مجدداً") }
                }
            }
        }
    }

    private fun showLoading(message: String) {
        root = baseLayout()
        val label = text(message, 16, Color.WHITE, true)
        label.gravity = Gravity.CENTER
        root.addView(label, match())
        setContentView(root)
    }

    private fun showLogin(message: String? = null) {
        root = baseLayout()
        addBrand(root)
        val card = card()
        root.addView(card, match())
        val heading = text("أهلاً بك من جديد", 23, Color.WHITE, true)
        heading.gravity = Gravity.RIGHT
        card.addView(heading, match())
        val desc = text("سجّل دخولك للوصول إلى محفظتك ومتابعة السوق", 14, muted)
        desc.gravity = Gravity.RIGHT
        desc.setPadding(0, dp(8), 0, dp(20))
        card.addView(desc, match())
        card.addView(fieldLabel("البريد الإلكتروني"))
        val email = input("أدخل البريد الإلكتروني", false)
        card.addView(email, fieldParams())
        card.addView(fieldLabel("كلمة المرور"))
        val password = input("أدخل كلمة المرور", true)
        card.addView(password, fieldParams())
        status = text(message ?: "بيانات الدخول محمية باتصال مشفّر", 12, muted)
        status.gravity = Gravity.CENTER
        status.setPadding(0, dp(8), 0, dp(10))
        card.addView(status, match())
        val login = actionButton("تسجيل الدخول")
        card.addView(login, fieldParams())
        login.setOnClickListener {
            val userEmail = email.text.toString().trim()
            val userPassword = password.text.toString()
            if (userEmail.isBlank() || userPassword.isBlank()) {
                status.text = "أدخل البريد الإلكتروني وكلمة المرور"
                return@setOnClickListener
            }
            login.isEnabled = false
            status.text = "جارٍ تسجيل الدخول..."
            executor.execute {
                try {
                    val result = requestWithCookie("POST", "/api/auth/login",
                        JSONObject().put("email", userEmail).put("password", userPassword).toString())
                    val cookie = result.second ?: throw Exception("لم يتم إنشاء جلسة آمنة")
                    saveSession(cookie)
                    val profile = request("GET", "/api/auth/me", null, cookie)
                    runOnUiThread { showDashboard(profile, cookie) }
                } catch (e: Exception) {
                    runOnUiThread {
                        status.text = e.message ?: "تعذّر تسجيل الدخول"
                        login.isEnabled = true
                    }
                }
            }
        }
        val footer = text("منصة SYR TRADER", 12, muted)
        footer.gravity = Gravity.CENTER
        footer.setPadding(0, dp(24), 0, 0)
        root.addView(footer, match())
        setContentView(root)
    }

    private fun showDashboard(profile: JSONObject, cookie: String) {
        root = baseLayout()
        addBrand(root)
        val user = profile.optJSONObject("user") ?: JSONObject()
        val card = card()
        root.addView(card, match())
        val greeting = text("مرحباً، ${user.optString("displayName", "المتداول")}", 22, Color.WHITE, true)
        greeting.gravity = Gravity.RIGHT
        card.addView(greeting, match())
        val code = profile.optString("memberCode", "")
        val email = user.optString("email", "")
        val details = text(if (code.isNotBlank()) "رقم العضوية: $code\n$email" else email, 13, muted)
        details.gravity = Gravity.RIGHT
        details.setPadding(0, dp(8), 0, dp(18))
        card.addView(details, match())
        val heading = text("ملخص المحفظة", 18, teal, true)
        heading.gravity = Gravity.RIGHT
        card.addView(heading, match())
        val wallets = profile.optJSONArray("wallets")
        if (wallets == null || wallets.length() == 0) {
            val empty = text("لا توجد بيانات محفظة لعرضها حالياً", 14, muted)
            empty.gravity = Gravity.RIGHT
            card.addView(empty, match())
        } else {
            for (i in 0 until wallets.length()) {
                val wallet = wallets.optJSONObject(i) ?: continue
                val symbol = wallet.optString("symbol", "")
                val name = wallet.optString("assetName", symbol)
                val minor = wallet.optLong("balanceMinor", 0L)
                val amount = if (symbol == "SYP") String.format("%,d", minor / 100) else String.format("%.2f", minor / 100.0)
                val line = text("$name ($symbol)     $amount", 16, Color.WHITE, true)
                line.gravity = Gravity.RIGHT
                line.setPadding(0, dp(12), 0, dp(12))
                card.addView(line, match())
            }
        }
        val rate = profile.optJSONObject("exchangeRate")
        val rateText = if (rate != null) "سعر الصرف: ${rate.optString("rate", "—")} ليرة" else "سعر الصرف غير محدد حالياً"
        val rateView = text(rateText, 13, muted)
        rateView.gravity = Gravity.RIGHT
        rateView.setPadding(0, dp(12), 0, 0)
        card.addView(rateView, match())
        val logout = actionButton("تسجيل الخروج")
        val params = fieldParams()
        params.topMargin = dp(18)
        card.addView(logout, params)
        logout.setOnClickListener {
            logout.isEnabled = false
            executor.execute {
                try { request("POST", "/api/auth/logout", "{}", cookie) } catch (_: Exception) {}
                clearSession()
                runOnUiThread { showLogin("تم تسجيل الخروج بأمان") }
            }
        }
        setContentView(root)
    }

    private fun request(method: String, path: String, body: String?, cookie: String): JSONObject {
        return requestWithCookie(method, path, body, cookie).first
    }

    private fun requestWithCookie(method: String, path: String, body: String?): Pair<JSONObject, String?> {
        return requestWithCookie(method, path, body, null)
    }

    private fun requestWithCookie(method: String, path: String, body: String?, cookie: String?): Pair<JSONObject, String?> {
        val connection = (URL(baseUrl + path).openConnection() as HttpURLConnection)
        try {
            connection.requestMethod = method
            connection.connectTimeout = 15000
            connection.readTimeout = 15000
            connection.setRequestProperty("Accept", "application/json")
            connection.setRequestProperty("Origin", origin)
            if (cookie != null) connection.setRequestProperty("Cookie", cookie)
            if (body != null) {
                connection.doOutput = true
                connection.setRequestProperty("Content-Type", "application/json; charset=utf-8")
                connection.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
            }
            val code = connection.responseCode
            val stream = if (code in 200..299) connection.inputStream else connection.errorStream
            val raw = stream?.bufferedReader()?.use { it.readText() } ?: "{}"
            val json = JSONObject(raw)
            if (code !in 200..299 || !json.optBoolean("ok", false)) {
                throw Exception(json.optString("error").ifBlank { "تعذّر الاتصال بالخادم ($code)" })
            }
            val setCookie = connection.getHeaderField("Set-Cookie")
            val token = setCookie?.split(";")?.firstOrNull()?.takeIf { it.startsWith("syr_session=") }
            return Pair(json, token ?: cookie)
        } finally {
            connection.disconnect()
        }
    }

    private fun saveSession(cookie: String) {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, sessionKey())
        val encrypted = cipher.doFinal(cookie.toByteArray(Charsets.UTF_8))
        val packed = ByteBuffer.allocate(4 + cipher.iv.size + encrypted.size)
            .putInt(cipher.iv.size).put(cipher.iv).put(encrypted).array()
        getSharedPreferences("secure_session", MODE_PRIVATE).edit()
            .putString("cookie", Base64.encodeToString(packed, Base64.NO_WRAP)).apply()
    }

    private fun readSession(): String? {
        return try {
            val encoded = getSharedPreferences("secure_session", MODE_PRIVATE).getString("cookie", null) ?: return null
            val packed = ByteBuffer.wrap(Base64.decode(encoded, Base64.NO_WRAP))
            val ivSize = packed.int
            require(ivSize in 12..16)
            val iv = ByteArray(ivSize).also { packed.get(it) }
            val encrypted = ByteArray(packed.remaining()).also { packed.get(it) }
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, sessionKey(), GCMParameterSpec(128, iv))
            String(cipher.doFinal(encrypted), Charsets.UTF_8)
        } catch (_: Exception) {
            clearSession()
            null
        }
    }

    private fun clearSession() {
        getSharedPreferences("secure_session", MODE_PRIVATE).edit().clear().apply()
    }

    private fun sessionKey(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey("syr_trader_session_key", null) as? SecretKey)?.let { return it }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        generator.init(KeyGenParameterSpec.Builder("syr_trader_session_key",
            KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setRandomizedEncryptionRequired(true)
            .build())
        return generator.generateKey()
    }

    private fun baseLayout() = LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL
        gravity = Gravity.CENTER_HORIZONTAL
        setPadding(dp(24), dp(28), dp(24), dp(28))
        setBackgroundColor(navy)
    }

    private fun addBrand(parent: LinearLayout) {
        val logo = text("SYR", 38, teal, true).apply {
            typeface = Typeface.create("sans-serif-black", Typeface.BOLD)
            gravity = Gravity.CENTER
        }
        parent.addView(logo, match())
        val title = text("TRADER", 23, Color.WHITE, true).apply {
            letterSpacing = 0.22f
            gravity = Gravity.CENTER
        }
        parent.addView(title, match())
        val powered = text("Powered by Kamash", 12, muted)
        powered.gravity = Gravity.CENTER
        powered.setPadding(0, dp(5), 0, dp(24))
        parent.addView(powered, match())
    }

    private fun card() = LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL
        setPadding(dp(20), dp(22), dp(20), dp(22))
        setBackgroundColor(panel)
    }

    private fun fieldLabel(value: String) = text(value, 13, Color.WHITE).apply {
        gravity = Gravity.RIGHT
        setPadding(0, dp(5), 0, dp(8))
    }

    private fun input(hintText: String, isPassword: Boolean) = EditText(this).apply {
        hint = hintText
        textSize = 15f
        setTextColor(Color.WHITE)
        setHintTextColor(muted)
        gravity = Gravity.RIGHT or Gravity.CENTER_VERTICAL
        setSingleLine(true)
        setPadding(dp(14), 0, dp(14), 0)
        setBackgroundColor(Color.rgb(27, 42, 64))
        inputType = if (isPassword) android.text.InputType.TYPE_CLASS_TEXT or android.text.InputType.TYPE_TEXT_VARIATION_PASSWORD
            else android.text.InputType.TYPE_CLASS_TEXT or android.text.InputType.TYPE_TEXT_VARIATION_EMAIL_ADDRESS
    }

    private fun actionButton(label: String) = Button(this).apply {
        text = label
        isAllCaps = false
        textSize = 16f
        setTextColor(navy)
        setBackgroundColor(teal)
    }

    private fun text(value: String, size: Int, color: Int, bold: Boolean = false) = TextView(this).apply {
        text = value
        textSize = size.toFloat()
        setTextColor(color)
        if (bold) typeface = Typeface.DEFAULT_BOLD
    }

    private fun match() = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
    private fun fieldParams() = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(52)).apply { bottomMargin = dp(14) }
    private fun dp(value: Int) = (value * resources.displayMetrics.density).toInt()
}
