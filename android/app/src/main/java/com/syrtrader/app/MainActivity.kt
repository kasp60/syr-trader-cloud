package com.syrtrader.app

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.graphics.Color
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Path
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
    private var activeCookie: String? = null
    private var pendingDepositAmount: String? = null

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
        activeCookie = cookie
        val user = profile.optJSONObject("user") ?: JSONObject()
        val code = profile.optString("memberCode", "")
        root = baseLayout()
        root.addView(ScrollView(this).apply {
            isFillViewport = true
            addView(LinearLayout(this@MainActivity).apply {
                orientation = LinearLayout.VERTICAL
                setPadding(0, 0, 0, dp(18))
                addBrand(this)
                val welcome = text("مرحباً، ${user.optString("displayName", "المتداول")}", 21, Color.WHITE, true)
                welcome.gravity = Gravity.RIGHT
                addView(welcome, match())
                val identity = text(if (code.isNotBlank()) "رقم العضوية: $code" else user.optString("email"), 12, muted)
                identity.gravity = Gravity.RIGHT
                identity.setPadding(0, dp(5), 0, dp(16))
                addView(identity, match())
                val nav = LinearLayout(this@MainActivity).apply {
                    orientation = LinearLayout.HORIZONTAL
                    gravity = Gravity.CENTER
                }
                val navItems = mutableListOf("الرئيسية", "المحفظة", "السوق", "الصفقات", "تداول")
                if (user.optString("role") == "admin") navItems.add("الإدارة")
                navItems.forEachIndexed { index, label ->
                    val b = Button(this@MainActivity).apply {
                        text = label
                        isAllCaps = false
                        textSize = 12f
                        setTextColor(Color.WHITE)
                        setBackgroundColor(panel)
                        setPadding(dp(3), 0, dp(3), 0)
                    }
                    nav.addView(b, LinearLayout.LayoutParams(0, dp(48), 1f).apply {
                        marginEnd = dp(3)
                    })
                    b.setOnClickListener {
                        when (index) {
                            0 -> loadHome(profile, cookie)
                            1 -> loadWallet(cookie)
                            2 -> loadMarket(cookie)
                            3 -> loadPositions(cookie)
                            4 -> loadTrading(cookie)
                            5 -> loadAdmin(cookie)
                        }
                    }
                }
                addView(nav, match())
                val telegram = actionButton("قناة تيليجرام الرسمية")
                addView(telegram, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(44)).apply { topMargin = dp(10) })
                telegram.setOnClickListener { startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("https://t.me/syriatrader2027"))) }
                val content = LinearLayout(this@MainActivity).apply {
                    orientation = LinearLayout.VERTICAL
                    setPadding(0, dp(14), 0, 0)
                }
                addView(content, match())
                loadHomeInto(content, profile, cookie)
                val logout = actionButton("تسجيل الخروج")
                addView(logout, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(50)).apply {
                    topMargin = dp(18)
                })
                logout.setOnClickListener {
                    logout.isEnabled = false
                    executor.execute {
                        try { request("POST", "/api/auth/logout", "{}", cookie) } catch (_: Exception) {}
                        clearSession()
                        runOnUiThread { showLogin("تم تسجيل الخروج بأمان") }
                    }
                }
            })
        })
        setContentView(root)
    }

    private fun loadHome(profile: JSONObject, cookie: String) {
        val content = dashboardContent() ?: return
        loadHomeInto(content, profile, cookie)
    }

    private fun loadHomeInto(content: LinearLayout, profile: JSONObject, cookie: String) {
        content.removeAllViews()
        val card = card()
        content.addView(card, match())
        val heading = text("ملخص الحساب", 19, teal, true)
        heading.gravity = Gravity.RIGHT
        card.addView(heading, match())
        val wallets = profile.optJSONArray("wallets")
        if (wallets != null) for (i in 0 until wallets.length()) {
            val w = wallets.optJSONObject(i) ?: continue
            val symbol = w.optString("symbol")
            val minor = w.optLong("balanceMinor")
            val amount = if (symbol == "SYP") String.format("%,d", minor / 100) else String.format("%.2f", minor / 100.0)
            val line = text("${w.optString("assetName")} ($symbol): $amount", 16, Color.WHITE, true)
            line.gravity = Gravity.RIGHT
            line.setPadding(0, dp(14), 0, dp(6))
            card.addView(line, match())
        }
        val rate = profile.optJSONObject("exchangeRate")
        val rateView = text(if (rate != null) "سعر الصرف: ${rate.optString("rate")} ليرة" else "سعر الصرف غير محدد حالياً", 13, muted)
        rateView.gravity = Gravity.RIGHT
        rateView.setPadding(0, dp(12), 0, 0)
        card.addView(rateView, match())
        val hint = text("استخدم التبويبات للوصول إلى المحفظة والسوق والصفقات.", 13, muted)
        hint.gravity = Gravity.RIGHT
        hint.setPadding(0, dp(14), 0, 0)
        content.addView(hint, match())
    }

    private fun loadWallet(cookie: String) {
        val content = dashboardContent() ?: return
        content.removeAllViews()
        val loading = text("جارٍ تحميل المحفظة...", 14, muted)
        content.addView(loading, match())
        executor.execute {
            try {
                val data = request("GET", "/api/wallet/ledger", null, cookie)
                val finance = request("GET", "/api/wallet/finance-requests", null, cookie)
                runOnUiThread {
                    content.removeAllViews()
                    val walletCard = card()
                    content.addView(walletCard, match())
                    val title = text("سجل المحفظة", 19, teal, true)
                    title.gravity = Gravity.RIGHT
                    walletCard.addView(title, match())
                    val entries = data.optJSONArray("entries")
                    if (entries == null || entries.length() == 0) {
                        val empty = text("لا توجد حركات مسجلة حتى الآن", 14, muted)
                        empty.gravity = Gravity.RIGHT
                        walletCard.addView(empty, match())
                    } else {
                        for (i in 0 until minOf(entries.length(), 30)) {
                            val e = entries.optJSONObject(i) ?: continue
                            val sign = if (e.optString("type") == "credit") "+" else "−"
                            val amount = e.optLong("amountMinor")
                            val value = if (e.optString("symbol") == "USD") String.format("%.2f", amount / 100.0) else String.format("%,d", amount / 100)
                            val row = text("$sign$value ${e.optString("symbol")}  •  ${e.optString("note", "حركة محفظة")}", 13, Color.WHITE)
                            row.gravity = Gravity.RIGHT
                            row.setPadding(0, dp(12), 0, dp(8))
                            walletCard.addView(row, match())
                        }
                    }
                    val actions = LinearLayout(this@MainActivity).apply { orientation = LinearLayout.VERTICAL }
                    val deposit = actionButton("طلب إيداع بالدولار")
                    actions.addView(deposit, fieldParams())
                    deposit.setOnClickListener { showDepositAmountDialog() }
                    val withdrawal = actionButton("طلب سحب بالليرة")
                    actions.addView(withdrawal, fieldParams())
                    withdrawal.setOnClickListener { showWithdrawalDialog(cookie) }
                    val transfer = actionButton("تحويل ليرة إلى عضو")
                    actions.addView(transfer, fieldParams())
                    transfer.setOnClickListener { showTransferDialog(cookie) }
                    content.addView(actions, match())
                    val requests = finance.optJSONArray("deposits")
                    val requestTitle = text("طلبات الإيداع", 17, teal, true)
                    requestTitle.gravity = Gravity.RIGHT
                    requestTitle.setPadding(0, dp(18), 0, dp(8))
                    content.addView(requestTitle, match())
                    if (requests == null || requests.length() == 0) {
                        val empty = text("لا توجد طلبات إيداع", 13, muted)
                        empty.gravity = Gravity.RIGHT
                        content.addView(empty, match())
                    } else for (i in 0 until minOf(requests.length(), 15)) {
                        val item = requests.optJSONObject(i) ?: continue
                        val amount = String.format("%.2f", item.optLong("amount") / 100.0)
                        val row = text("$amount ${item.optString("assetSymbol", "USD")}  •  ${item.optString("status")}", 13, Color.WHITE)
                        row.gravity = Gravity.RIGHT
                        content.addView(row, match())
                    }
                    val withdrawals = finance.optJSONArray("withdrawals")
                    val withdrawalsTitle = text("طلبات السحب", 17, teal, true)
                    withdrawalsTitle.gravity = Gravity.RIGHT
                    withdrawalsTitle.setPadding(0, dp(16), 0, dp(8))
                    content.addView(withdrawalsTitle, match())
                    if (withdrawals != null) for (i in 0 until minOf(withdrawals.length(), 15)) {
                        val item = withdrawals.optJSONObject(i) ?: continue
                        val amount = String.format("%,d", item.optLong("amount") / 100)
                        val row = text("$amount ليرة  •  ${item.optString("status")}", 13, Color.WHITE)
                        row.gravity = Gravity.RIGHT
                        content.addView(row, match())
                    }
                    val transfers = finance.optJSONArray("transfers")
                    val transfersTitle = text("التحويلات الداخلية", 17, teal, true)
                    transfersTitle.gravity = Gravity.RIGHT
                    transfersTitle.setPadding(0, dp(16), 0, dp(8))
                    content.addView(transfersTitle, match())
                    if (transfers != null) for (i in 0 until minOf(transfers.length(), 15)) {
                        val item = transfers.optJSONObject(i) ?: continue
                        val amount = String.format("%,d", item.optLong("amount") / 100)
                        val direction = if (item.optString("direction") == "out") "إلى" else "من"
                        val row = text("$direction ${item.optString("otherName")} • $amount ليرة", 13, Color.WHITE)
                        row.gravity = Gravity.RIGHT
                        content.addView(row, match())
                    }
                }
            } catch (e: Exception) {
                runOnUiThread { content.removeAllViews(); showError(content, e.message) }
            }
        }
    }

    private fun showDepositAmountDialog() {
        val amount = input("مبلغ الإيداع بالدولار", false)
        amount.inputType = android.text.InputType.TYPE_CLASS_NUMBER or android.text.InputType.TYPE_NUMBER_FLAG_DECIMAL
        android.app.AlertDialog.Builder(this)
            .setTitle("طلب إيداع")
            .setMessage("أدخل المبلغ ثم اختر صورة إثبات التحويل. الحد الأقصى للصورة 850 كيلوبايت.")
            .setView(amount)
            .setNegativeButton("إلغاء", null)
            .setPositiveButton("اختيار صورة") { _, _ ->
                val value = amount.text.toString().trim()
                if (value.toDoubleOrNull() == null || value.toDoubleOrNull()!! <= 0) {
                    android.widget.Toast.makeText(this, "أدخل مبلغاً صحيحاً", android.widget.Toast.LENGTH_LONG).show()
                } else {
                    pendingDepositAmount = value
                    val picker = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
                        addCategory(Intent.CATEGORY_OPENABLE)
                        type = "image/*"
                    }
                    startActivityForResult(picker, 701)
                }
            }.show()
    }

    private fun showWithdrawalDialog(cookie: String) {
        val amount = input("المبلغ بالليرة (عدد صحيح)", false)
        amount.inputType = android.text.InputType.TYPE_CLASS_NUMBER
        val details = input("بيانات استلام الحوالة", false)
        val box = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(20), dp(8), dp(20), 0)
            addView(amount, fieldParams())
            addView(details, fieldParams())
        }
        android.app.AlertDialog.Builder(this)
            .setTitle("طلب سحب")
            .setView(box)
            .setNegativeButton("إلغاء", null)
            .setPositiveButton("إرسال الطلب") { _, _ ->
                val whole = amount.text.toString().trim().toLongOrNull()
                val payout = details.text.toString().trim()
                if (whole == null || whole <= 0 || whole > 10000000000L || payout.length < 5) {
                    android.widget.Toast.makeText(this, "تحقق من المبلغ وبيانات الاستلام", android.widget.Toast.LENGTH_LONG).show()
                } else sendWalletAction(cookie, "/api/wallet/withdrawal",
                    JSONObject().put("amount", whole * 100L).put("payoutDetails", payout), "تم إرسال طلب السحب")
            }.show()
    }

    private fun showTransferDialog(cookie: String) {
        val code = input("رقم العضوية (10 أرقام)", false)
        code.inputType = android.text.InputType.TYPE_CLASS_NUMBER
        val amount = input("المبلغ بالليرة (عدد صحيح)", false)
        amount.inputType = android.text.InputType.TYPE_CLASS_NUMBER
        val box = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(20), dp(8), dp(20), 0)
            addView(code, fieldParams())
            addView(amount, fieldParams())
        }
        android.app.AlertDialog.Builder(this)
            .setTitle("تحويل داخلي")
            .setView(box)
            .setNegativeButton("إلغاء", null)
            .setPositiveButton("تحويل") { _, _ ->
                val member = code.text.toString().trim()
                val whole = amount.text.toString().trim().toLongOrNull()
                if (!member.matches(Regex("[0-9]{10}")) || whole == null || whole <= 0 || whole > 10000000000L) {
                    android.widget.Toast.makeText(this, "تحقق من رقم العضوية والمبلغ", android.widget.Toast.LENGTH_LONG).show()
                } else sendWalletAction(cookie, "/api/wallet/transfer",
                    JSONObject().put("memberCode", member).put("amount", whole * 100L), "تم تنفيذ التحويل الداخلي")
            }.show()
    }

    private fun sendWalletAction(cookie: String, path: String, payload: JSONObject, success: String) {
        executor.execute {
            try {
                request("POST", path, payload.toString(), cookie)
                runOnUiThread {
                    android.widget.Toast.makeText(this, success, android.widget.Toast.LENGTH_LONG).show()
                    loadWallet(cookie)
                }
            } catch (e: Exception) {
                runOnUiThread { android.widget.Toast.makeText(this, e.message ?: "تعذر تنفيذ الطلب", android.widget.Toast.LENGTH_LONG).show() }
            }
        }
    }

    @Deprecated("Deprecated in Android API")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode != 701 || resultCode != Activity.RESULT_OK) return
        val uri = data?.data ?: return
        val amount = pendingDepositAmount ?: return
        val cookie = activeCookie ?: return
        pendingDepositAmount = null
        executor.execute {
            try {
                val mime = contentResolver.getType(uri) ?: throw Exception("تعذر تحديد نوع الصورة")
                if (mime !in listOf("image/jpeg", "image/png", "image/webp")) throw Exception("الصورة يجب أن تكون JPG أو PNG أو WEBP")
                val bytes = contentResolver.openInputStream(uri)?.use { it.readBytes() } ?: throw Exception("تعذر قراءة الصورة")
                if (bytes.isEmpty() || bytes.size > 850000) throw Exception("حجم الصورة يجب ألا يتجاوز 850 كيلوبايت")
                val boundary = "----SYRTRADER" + java.util.UUID.randomUUID().toString().replace("-", "")
                val connection = (URL(baseUrl + "/api/wallet/deposit").openConnection() as HttpURLConnection)
                try {
                    connection.requestMethod = "POST"
                    connection.connectTimeout = 20000
                    connection.readTimeout = 20000
                    connection.doOutput = true
                    connection.setRequestProperty("Accept", "application/json")
                    connection.setRequestProperty("Origin", origin)
                    connection.setRequestProperty("Cookie", cookie)
                    connection.setRequestProperty("Content-Type", "multipart/form-data; boundary=$boundary")
                    connection.outputStream.use { out ->
                        fun field(name: String, value: String) {
                            out.write("--$boundary\r\n".toByteArray())
                            out.write("Content-Disposition: form-data; name=\"$name\"\r\n\r\n".toByteArray())
                            out.write(value.toByteArray(Charsets.UTF_8))
                            out.write("\r\n".toByteArray())
                        }
                        field("amount", amount)
                        out.write("--$boundary\r\n".toByteArray())
                        out.write("Content-Disposition: form-data; name=\"proof\"; filename=\"proof\"\r\n".toByteArray())
                        out.write("Content-Type: $mime\r\n\r\n".toByteArray())
                        out.write(bytes)
                        out.write("\r\n--$boundary--\r\n".toByteArray())
                    }
                    val code = connection.responseCode
                    val stream = if (code in 200..299) connection.inputStream else connection.errorStream
                    val response = JSONObject(stream?.bufferedReader()?.use { it.readText() } ?: "{}")
                    if (code !in 200..299 || !response.optBoolean("ok", false)) throw Exception(response.optString("error").ifBlank { "تعذر إرسال طلب الإيداع" })
                    runOnUiThread {
                        android.widget.Toast.makeText(this, "تم إرسال طلب الإيداع للمراجعة", android.widget.Toast.LENGTH_LONG).show()
                        loadWallet(cookie)
                    }
                } finally {
                    connection.disconnect()
                }
            } catch (e: Exception) {
                runOnUiThread { android.widget.Toast.makeText(this, e.message ?: "تعذر رفع إثبات الإيداع", android.widget.Toast.LENGTH_LONG).show() }
            }
        }
    }

    private fun loadMarket(cookie: String) {
        val content = dashboardContent() ?: return
        content.removeAllViews()
        content.addView(text("جارٍ تحميل بيانات السوق...", 14, muted), match())
        executor.execute {
            try {
                val board = request("GET", "/api/market/board", null, cookie)
                val chart = request("GET", "/api/market/chart", null, cookie)
                runOnUiThread {
                    content.removeAllViews()
                    val card = card()
                    content.addView(card, match())
                    val title = text("السوق الداخلي", 19, teal, true)
                    title.gravity = Gravity.RIGHT
                    card.addView(title, match())
                    val market = board.optJSONArray("market")
                    if (market != null) for (i in 0 until market.length()) {
                        val m = market.optJSONObject(i) ?: continue
                        val price = m.optLong("priceMicro") / 1000000.0
                        val line = text("${m.optString("symbol")}   ${String.format("%.2f", price)} ليرة", 18, Color.WHITE, true)
                        line.gravity = Gravity.RIGHT
                        line.setPadding(0, dp(16), 0, dp(10))
                        card.addView(line, match())
                    }
                    val points = chart.optJSONArray("points")
                    val chartValues = mutableListOf<Float>()
                    if (points != null) for (i in 0 until points.length()) {
                        val value = points.optJSONObject(i)?.optLong("priceMicro", 0L) ?: 0L
                        if (value > 0L) chartValues.add(value / 1000000f)
                    }
                    val chartTitle = text("حركة السعر", 16, Color.WHITE, true)
                    chartTitle.gravity = Gravity.RIGHT
                    chartTitle.setPadding(0, dp(18), 0, dp(8))
                    card.addView(chartTitle, match())
                    card.addView(PriceChartView(chartValues), LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(190)))
                    val count = chartValues.size
                    val chartInfo = text("عدد نقاط سجل السعر: $count", 12, muted)
                    chartInfo.gravity = Gravity.RIGHT
                    card.addView(chartInfo, match())
                    val open = board.optJSONArray("openTrades")
                    val tradesTitle = text("صفقاتك المفتوحة: ${open?.length() ?: 0}", 15, Color.WHITE, true)
                    tradesTitle.gravity = Gravity.RIGHT
                    tradesTitle.setPadding(0, dp(18), 0, 0)
                    card.addView(tradesTitle, match())
                }
            } catch (e: Exception) {
                runOnUiThread { content.removeAllViews(); showError(content, e.message) }
            }
        }
    }

    private fun loadTrading(cookie: String) {
        val content = dashboardContent() ?: return
        content.removeAllViews()
        content.addView(text("جارٍ تحميل بيانات التداول...", 14, muted), match())
        executor.execute {
            try {
                val board = request("GET", "/api/market/board", null, cookie)
                runOnUiThread {
                    content.removeAllViews()
                    val market = board.optJSONArray("market")
                    val instrument = market?.optJSONObject(0)
                    if (instrument == null || instrument.optString("id").isBlank()) {
                        showError(content, "السوق غير متاح حالياً")
                        return@runOnUiThread
                    }
                    val card = card()
                    content.addView(card, match())
                    val title = text("فتح صفقة داخلية", 19, teal, true)
                    title.gravity = Gravity.RIGHT
                    card.addView(title, match())
                    val disclaimer = text("هذا تداول محاكاة داخل المنصة. الشراء هامشه بالليرة والبيع هامشه بالدولار.", 12, muted)
                    disclaimer.gravity = Gravity.RIGHT
                    disclaimer.setPadding(0, dp(8), 0, dp(16))
                    card.addView(disclaimer, match())
                    val price = instrument.optLong("priceMicro") / 1000000.0
                    val priceView = text("${instrument.optString("symbol")}  •  ${String.format("%.2f", price)} ليرة", 17, Color.WHITE, true)
                    priceView.gravity = Gravity.RIGHT
                    card.addView(priceView, match())
                    val marginLabel = fieldLabel("مبلغ الهامش (شراء: ليرة صحيحة / بيع: دولار)")
                    marginLabel.setPadding(0, dp(16), 0, dp(8))
                    card.addView(marginLabel, match())
                    val margin = input("مثال: 100000", false)
                    margin.inputType = android.text.InputType.TYPE_CLASS_NUMBER or android.text.InputType.TYPE_NUMBER_FLAG_DECIMAL
                    card.addView(margin, fieldParams())
                    card.addView(fieldLabel("الرافعة المالية (من 1 إلى 20)"))
                    val leverage = input("1", false)
                    leverage.setText("1")
                    leverage.inputType = android.text.InputType.TYPE_CLASS_NUMBER
                    card.addView(leverage, fieldParams())
                    val result = text("أدخل الهامش والرافعة ثم اختر شراء أو بيع.", 12, muted)
                    result.gravity = Gravity.CENTER
                    result.setPadding(0, dp(8), 0, dp(12))
                    card.addView(result, match())
                    fun submit(direction: String, button: Button) {
                        val amount = margin.text.toString().trim().toDoubleOrNull()
                        val lev = leverage.text.toString().trim().toIntOrNull()
                        if (amount == null || amount <= 0 || lev == null || lev !in 1..20 || (direction == "long" && amount % 1.0 != 0.0)) {
                            result.text = "تحقق من مبلغ الهامش والرافعة؛ شراء الليرة يجب أن يكون عدداً صحيحاً."
                            return
                        }
                        button.isEnabled = false
                        result.text = "جارٍ إرسال أمر الصفقة..."
                        executor.execute {
                            try {
                                val payload = JSONObject().put("instrumentId", instrument.optString("id")).put("direction", direction).put("margin", amount).put("leverage", lev)
                                val response = request("POST", "/api/paper/trade-open", payload.toString(), cookie)
                                runOnUiThread { result.text = "تم فتح الصفقة. رقمها: ${response.optString("tradeId")}"; button.isEnabled = true }
                            } catch (e: Exception) {
                                runOnUiThread { result.text = e.message ?: "تعذر فتح الصفقة"; button.isEnabled = true }
                            }
                        }
                    }
                    val buy = actionButton("شراء — هامش بالليرة")
                    card.addView(buy, fieldParams())
                    buy.setOnClickListener { submit("long", buy) }
                    val sell = actionButton("بيع — هامش بالدولار")
                    card.addView(sell, fieldParams())
                    sell.setOnClickListener { submit("short", sell) }
                }
            } catch (e: Exception) {
                runOnUiThread { content.removeAllViews(); showError(content, e.message) }
            }
        }
    }
    private fun loadAdmin(cookie: String) {
        val content = dashboardContent() ?: return
        content.removeAllViews()
        content.addView(text("جارٍ تحميل لوحة الإدارة...", 14, muted), match())
        executor.execute {
            try {
                val users = request("GET", "/api/admin/users", null, cookie)
                val finance = request("GET", "/api/admin/finance-requests", null, cookie)
                val reserve = request("GET", "/api/admin/platform-reserve", null, cookie)
                runOnUiThread {
                    content.removeAllViews()
                    val summary = card()
                    content.addView(summary, match())
                    val heading = text("لوحة الإدارة", 20, teal, true)
                    heading.gravity = Gravity.RIGHT
                    summary.addView(heading, match())
                    val userRows = users.optJSONArray("users")
                    val depositRows = finance.optJSONArray("deposits")
                    val withdrawalRows = finance.optJSONArray("withdrawals")
                    fun pendingCount(rows: org.json.JSONArray?): Int {
                        var count = 0
                        if (rows != null) for (i in 0 until rows.length()) {
                            if (rows.optJSONObject(i)?.optString("status") == "pending") count++
                        }
                        return count
                    }
                    val stats = listOf(
                        "عدد الحسابات: ${userRows?.length() ?: 0}",
                        "طلبات الإيداع المعلقة: ${pendingCount(depositRows)}",
                        "طلبات السحب المعلقة: ${pendingCount(withdrawalRows)}"
                    )
                    stats.forEach { value ->
                        val line = text(value, 15, Color.WHITE, true)
                        line.gravity = Gravity.RIGHT
                        line.setPadding(0, dp(12), 0, dp(6))
                        summary.addView(line, match())
                    }
                    val reserveTitle = text("احتياطي المنصة", 17, teal, true)
                    reserveTitle.gravity = Gravity.RIGHT
                    reserveTitle.setPadding(0, dp(18), 0, dp(8))
                    content.addView(reserveTitle, match())
                    val balances = reserve.optJSONArray("balances")
                    if (balances == null || balances.length() == 0) {
                        val empty = text("لا توجد بيانات احتياطي", 13, muted)
                        empty.gravity = Gravity.RIGHT
                        content.addView(empty, match())
                    } else for (i in 0 until balances.length()) {
                        val item = balances.optJSONObject(i) ?: continue
                        val symbol = item.optString("assetSymbol")
                        val available = item.optLong("availableMinor") / 100.0
                        val reserved = item.optLong("reservedMinor") / 100.0
                        val line = text("$symbol • المتاح: ${String.format("%.2f", available)} • المحجوز: ${String.format("%.2f", reserved)}", 13, Color.WHITE)
                        line.gravity = Gravity.RIGHT
                        line.setPadding(0, dp(8), 0, dp(4))
                        content.addView(line, match())
                    }
                    val financeTitle = text("آخر الطلبات المالية", 17, teal, true)
                    financeTitle.gravity = Gravity.RIGHT
                    financeTitle.setPadding(0, dp(18), 0, dp(8))
                    content.addView(financeTitle, match())
                    fun addRequests(rows: org.json.JSONArray?, label: String) {
                        if (rows == null) return
                        for (i in 0 until minOf(rows.length(), 15)) {
                            val item = rows.optJSONObject(i) ?: continue
                            val amount = item.optLong("amount") / 100.0
                            val line = text("$label • ${item.optString("displayName")} • ${String.format("%.2f", amount)} • ${item.optString("status")}", 12, Color.WHITE)
                            line.gravity = Gravity.RIGHT
                            line.setPadding(0, dp(7), 0, dp(4))
                            content.addView(line, match())
                        }
                    }
                    addRequests(depositRows, "إيداع")
                    addRequests(withdrawalRows, "سحب")
                }
            } catch (e: Exception) {
                runOnUiThread { content.removeAllViews(); showError(content, e.message) }
            }
        }
    }

    private fun loadPositions(cookie: String) {
        val content = dashboardContent() ?: return
        content.removeAllViews()
        content.addView(text("جارٍ تحميل الصفقات...", 14, muted), match())
        executor.execute {
            try {
                val board = request("GET", "/api/market/board", null, cookie)
                runOnUiThread {
                    content.removeAllViews()
                    val open = board.optJSONArray("openTrades")
                    val closed = board.optJSONArray("closedTrades")
                    addTradeSection(content, "الصفقات المفتوحة", open, true, cookie)
                    addTradeSection(content, "الصفقات المغلقة", closed, false, cookie)
                }
            } catch (e: Exception) {
                runOnUiThread { content.removeAllViews(); showError(content, e.message) }
            }
        }
    }

    private fun addTradeSection(content: LinearLayout, titleText: String, rows: org.json.JSONArray?, isOpen: Boolean, cookie: String) {
        val section = card()
        val title = text(titleText, 18, teal, true)
        title.gravity = Gravity.RIGHT
        section.addView(title, match())
        val count = rows?.length() ?: 0
        if (count == 0) {
            val empty = text("لا توجد صفقات", 13, muted)
            empty.gravity = Gravity.RIGHT
            section.addView(empty, match())
        } else for (i in 0 until minOf(count, 30)) {
            val t = rows?.optJSONObject(i) ?: continue
            val dir = if (t.optString("direction") == "long") "شراء" else "بيع"
            val priceKey = if (isOpen) "entryPriceMicro" else "exitPriceMicro"
            val price = t.optLong(priceKey) / 1000000.0
            val pnl = if (!isOpen) "  •  نتيجة: ${String.format("%.2f", t.optLong("pnlCents") / 100.0)}" else ""
            val row = text("$dir  •  ${t.optInt("leverage")}x  •  سعر: ${String.format("%.2f", price)}$pnl", 13, Color.WHITE)
            row.gravity = Gravity.RIGHT
            row.setPadding(0, dp(12), 0, dp(7))
            section.addView(row, match())
            if (isOpen) {
                val close = actionButton("إغلاق الصفقة")
                section.addView(close, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(44)).apply {
                    topMargin = dp(6)
                    bottomMargin = dp(8)
                })
                close.setOnClickListener {
                    android.app.AlertDialog.Builder(this)
                        .setTitle("تأكيد إغلاق الصفقة")
                        .setMessage("سيتم إغلاق الصفقة وتسوية نتيجتها حسب السعر الحالي. هل تريد المتابعة؟")
                        .setNegativeButton("إلغاء", null)
                        .setPositiveButton("إغلاق") { _, _ ->
                            close.isEnabled = false
                            executor.execute {
                                try {
                                    val payload = JSONObject().put("tradeId", t.optString("id"))
                                    request("POST", "/api/paper/trade-close", payload.toString(), cookie)
                                    runOnUiThread { loadPositions(cookie) }
                                } catch (e: Exception) {
                                    runOnUiThread { close.isEnabled = true; close.text = e.message ?: "تعذر إغلاق الصفقة" }
                                }
                            }
                        }.show()
                }
            }
        }
        content.addView(section, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
            bottomMargin = dp(12)
        })
    }

    private fun dashboardContent(): LinearLayout? {
        val scroll = root.getChildAt(0) as? ScrollView ?: return null
        val page = scroll.getChildAt(0) as? LinearLayout ?: return null
        return page.getChildAt(7) as? LinearLayout
    }

    private inner class PriceChartView(private val values: List<Float>) : View(this@MainActivity) {
        private val linePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            color = teal
            strokeWidth = dp(2).toFloat()
            style = Paint.Style.STROKE
            strokeCap = Paint.Cap.ROUND
            strokeJoin = Paint.Join.ROUND
        }
        private val gridPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            color = Color.rgb(47, 65, 88)
            strokeWidth = dp(1).toFloat()
        }
        private val fillPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            color = Color.rgb(22, 65, 72)
            style = Paint.Style.FILL
            alpha = 110
        }
        private val labelPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            color = muted
            textSize = dp(10).toFloat()
        }

        override fun onDraw(canvas: Canvas) {
            super.onDraw(canvas)
            val left = dp(8).toFloat()
            val right = width - dp(8).toFloat()
            val top = dp(12).toFloat()
            val bottom = height - dp(18).toFloat()
            canvas.drawColor(panel)
            for (i in 0..3) {
                val y = top + (bottom - top) * i / 3f
                canvas.drawLine(left, y, right, y, gridPaint)
            }
            if (values.size < 2) {
                canvas.drawText("لا تتوفر بيانات كافية للرسم بعد", left, height / 2f, labelPaint)
                return
            }
            val minValue = values.minOrNull() ?: return
            val maxValue = values.maxOrNull() ?: return
            val range = (maxValue - minValue).takeIf { it > 0f } ?: 1f
            val path = Path()
            values.forEachIndexed { index, value ->
                val x = left + (right - left) * index / (values.size - 1).toFloat()
                val y = bottom - ((value - minValue) / range) * (bottom - top)
                if (index == 0) path.moveTo(x, y) else path.lineTo(x, y)
            }
            val fill = Path(path).apply {
                lineTo(right, bottom)
                lineTo(left, bottom)
                close()
            }
            canvas.drawPath(fill, fillPaint)
            canvas.drawPath(path, linePaint)
            canvas.drawText(String.format("%.2f", maxValue), left, top - dp(2), labelPaint)
            canvas.drawText(String.format("%.2f", minValue), left, height - dp(2).toFloat(), labelPaint)
        }
    }

    private fun showError(content: LinearLayout, message: String?) {
        val error = text(message ?: "تعذر تحميل البيانات", 13, Color.rgb(255, 130, 130))
        error.gravity = Gravity.RIGHT
        content.addView(error, match())
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
