<<<<<<< HEAD
# KAAPPAN Emergency Safety App

## Project structure

- `public/index.html` — single-page frontend
- `server.js` — Node.js + Express backend
- `schema.sql` — MySQL database and tables
- `.env.example` — environment configuration template

## 1. Create the database

1. Open Laragon and start MySQL.
2. Open phpMyAdmin.
3. Import `schema.sql` (or paste its SQL into the SQL tab and run it).

## 2. Install packages

Open a terminal in this project folder:

```bash
npm install
```

Copy `.env.example` to `.env` and set the values. In PowerShell:

```powershell
Copy-Item .env.example .env
```

Set `SESSION_SECRET` to a long random secret. Do not share `.env` or commit it to GitHub.

## 3. Run

```bash
npm start
```

Open `http://localhost:3000`.

The app and API are served from the same origin, so do not open `public/index.html` directly as a `file://` URL.

## 4. SMS and WhatsApp setup

By default the app will save SOS events but will clearly show that delivery providers are not configured. To send real messages, configure the optional Twilio values in `.env`:

- `TWILIO_ACCOUNT_SID`
- `TWILIO_AUTH_TOKEN`
- `TWILIO_SMS_FROM`
- `TWILIO_WHATSAPP_FROM`

Use a Twilio-approved SMS sender and WhatsApp sender. For WhatsApp sandbox testing, each recipient must follow the sandbox opt-in instructions. Production WhatsApp delivery may require approved templates and recipient opt-in, especially outside the 24-hour customer-service window. Provider rules and regional restrictions apply.

A provider acceptance response is not proof that the recipient received or read the message. Test with your own numbers first and never test emergency dispatch against people without their agreement.

## 5. Phone testing

For testing on the same phone, `localhost` points to the phone itself, not your PC. On a local Wi-Fi network, use your PC's LAN IP in the phone browser, for example `http://192.168.1.10:3000`, and allow Node.js through the Windows firewall on a private network. Browser geolocation generally requires HTTPS or localhost; a LAN HTTP address may not grant location access. For reliable GPS on a phone, use HTTPS or package the site as a native Android app.

This starter is a web app, not a native Android app. It cannot silently send SMS using the phone SIM, read hardware volume keys reliably, or run background safety monitoring when the browser is closed. Those features require a native Android implementation and Android permissions/policies.

## Security notes

- Passwords are hashed with bcrypt.
- Sessions are stored in MySQL and use HTTP-only cookies.
- The app rate-limits login/register and SOS endpoints.
- Contact ownership is checked on every operation.
- Add HTTPS, CSRF protection appropriate to your deployment, monitoring, backups, and a stricter Content Security Policy before public production use.
- Never put provider secrets in `index.html`.
=======
# kaappan
>>>>>>> eaf898ebd840056c6089995c88df81b8be8e3555
