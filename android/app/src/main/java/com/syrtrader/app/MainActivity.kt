package com.syrtrader.app

import android.app.Activity
import android.graphics.Color
import android.graphics.Typeface
import android.os.Bundle
import android.view.Gravity
import android.view.ViewGroup
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView

class MainActivity : Activity() {
    private val navy = Color.rgb(8, 15, 28)
    private val panel = Color.rgb(17, 28, 46)
    private val teal = Color.rgb(35, 190, 170)
    private val muted = Color.rgb(160, 174, 195)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.statusBarColor = navy
        window.navigationBarColor = navy
        window.decorView.setBackgroundColor(navy)

        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_HORIZONTAL
            setPadding(dp(28), dp(32), dp(28), dp(28))
            setBackgroundColor(navy)
        }

        val spacerTop = TextView(this).apply { text = ""; height = dp(30) }
        root.addView(spacerTop)

        val logo = TextView(this).apply {
            text = "SYR"
            textSize = 38f
            setTextColor(teal)
            typeface = Typeface.create("sans-serif-black", Typeface.BOLD)
            gravity = Gravity.CENTER
        }
        root.addView(logo, matchWrap())

        val title = TextView(this).apply {
            text = "TRADER"
            textSize = 23f
            letterSpacing = 0.22f
            setTextColor(Color.WHITE)
            typeface = Typeface.create("sans-serif-medium", Typeface.BOLD)
            gravity = Gravity.CENTER
        }
        root.addView(title, matchWrap())

        val powered = TextView(this).apply {
            text = "Powered by Kamash"
            textSize = 12f
            setTextColor(muted)
            gravity = Gravity.CENTER
            setPadding(0, dp(5), 0, dp(28))
        }
        root.addView(powered, matchWrap())

        val card = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(22), dp(24), dp(22), dp(22))
            setBackgroundColor(panel)
        }
        root.addView(card, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))

        val welcome = TextView(this).apply {
            text = "أهلاً بك من جديد"
            textSize = 23f
            setTextColor(Color.WHITE)
            typeface = Typeface.DEFAULT_BOLD
            gravity = Gravity.RIGHT
        }
        card.addView(welcome, matchWrap())

        val description = TextView(this).apply {
            text = "سجّل دخولك للوصول إلى محفظتك ومتابعة السوق"
            textSize = 14f
            setTextColor(muted)
            gravity = Gravity.RIGHT
            setPadding(0, dp(8), 0, dp(22))
        }
        card.addView(description, matchWrap())

        card.addView(fieldLabel("البريد الإلكتروني أو رقم العضوية"))
        val username = inputField("أدخل بيانات الحساب", false)
        card.addView(username, fieldParams())

        card.addView(fieldLabel("كلمة المرور"))
        val password = inputField("أدخل كلمة المرور", true)
        card.addView(password, fieldParams())

        val status = TextView(this).apply {
            text = "يجري تجهيز ربط تسجيل الدخول بالخادم"
            textSize = 12f
            setTextColor(muted)
            gravity = Gravity.CENTER
            setPadding(0, dp(18), 0, 0)
        }
        card.addView(status, matchWrap())

        val footer = TextView(this).apply {
            text = "منصة SYR TRADER"
            textSize = 12f
            setTextColor(muted)
            gravity = Gravity.CENTER
            setPadding(0, dp(28), 0, 0)
        }
        root.addView(footer, matchWrap())

        setContentView(root)
    }

    private fun fieldLabel(value: String) = TextView(this).apply {
        text = value
        textSize = 13f
        setTextColor(Color.WHITE)
        gravity = Gravity.RIGHT
        setPadding(0, dp(5), 0, dp(8))
    }

    private fun inputField(hintText: String, isPassword: Boolean) = EditText(this).apply {
        hint = hintText
        textSize = 15f
        setTextColor(Color.WHITE)
        setHintTextColor(muted)
        gravity = Gravity.RIGHT or Gravity.CENTER_VERTICAL
        setSingleLine(true)
        setPadding(dp(14), 0, dp(14), 0)
        setBackgroundColor(Color.rgb(27, 42, 64))
        if (isPassword) inputType = android.text.InputType.TYPE_CLASS_TEXT or android.text.InputType.TYPE_TEXT_VARIATION_PASSWORD
        else inputType = android.text.InputType.TYPE_CLASS_TEXT
    }

    private fun matchWrap() = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
    private fun fieldParams() = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(52)).apply { bottomMargin = dp(14) }
    private fun dp(value: Int) = (value * resources.displayMetrics.density).toInt()
}
