# AI Student Assistant

This project should be run with the Node.js server, not with VS Code Live Server.

## Run in VS Code

### Easiest way

1. Open this folder in VS Code.
2. Open `Run and Debug`.
3. Choose `Launch AI Student Assistant`.
4. Press `F5`.

VS Code will start the server and open the website automatically.

### Terminal way

1. Open this folder in VS Code.
2. Open `Terminal > New Terminal`.
3. Run:

```powershell
npm run dev
```

4. Wait for:

```text
AI Student Assistant is ready.
Local: http://localhost:3000
```

5. Open Chrome and go to:

```text
http://localhost:3000/index.html
```

## Share on the same Wi-Fi

If your server is running, the terminal will also show one or more `Same Wi-Fi sharing` URLs such as:

```text
http://192.168.1.5:3000
```

Anyone on the same Wi-Fi can open that URL while:

- your laptop is on
- `npm run dev` is still running
- Ollama is running

## Share outside your network

`localhost` only works on your own machine. If you want friends outside your Wi-Fi to use it, you will need one of these:

- a real deployment later
- a temporary tunnel such as Cloudflare Tunnel or ngrok

For now, the easiest no-deployment sharing option is the same-Wi-Fi link shown in the terminal.

## Free deployment with GitHub + Render

This app is a full-stack Express app, so do not use GitHub Pages for the main project. GitHub Pages is for static websites only.

The easiest free deployment path is:

1. Push this project to a GitHub repository.
2. Create a free Render account.
3. Connect your GitHub account to Render.
4. Create a new `Web Service` from this repository.
5. Render can read `render.yaml` from this project and use:
   - `npm install`
   - `npm start`
6. Your app will get a public `onrender.com` link.

### Important deployment note

The deployed free version should use:

```text
AI_PROVIDER=fallback
```

because local Ollama does not run on Render's free web service. The deployed website will still work, but chatbot responses will use the built-in fallback logic unless you later connect a cloud AI provider.

### Data note

This project currently stores demo users in a local file. On free cloud hosting, local file storage is temporary and may reset after redeploys or idle restarts. For a permanent production version, connect a real database later.

## Push to GitHub

If your repository is not connected yet:

```powershell
git init
git add .
git commit -m "Initial AI Student Assistant"
git branch -M main
git remote add origin YOUR_GITHUB_REPO_URL
git push -u origin main
```

## Deploy on Vercel

This project can also be deployed on Vercel because Vercel now supports Express apps with zero configuration.

### Important Vercel notes

- Vercel serves static files from `public/**`
- this project uses a script to copy `css/` and `js/` into `public/` during install
- local Ollama will not run on Vercel, so use fallback mode there unless you connect a cloud AI provider

### Steps

1. Push the project to GitHub.
2. Go to [vercel.com/new](https://vercel.com/new).
3. Import your GitHub repository.
4. Let Vercel detect the project automatically as an Express app.
5. In Environment Variables, set:

```text
AI_PROVIDER=fallback
HOST=0.0.0.0
```

6. Deploy.

### Optional environment variables

If you want the same owner-only analytics rules in production, also set:

```text
OWNER_EMAILS=your-email@example.com
```

### Limitation

The Vercel deployment will not use your laptop's Ollama model. It will still work, but the AI features will use fallback logic unless you later connect OpenAI or another cloud model provider.

## Important

- Do not use `Go Live`.
- Do not use port `5500`.
- Use `localhost:3000`.

## Main pages

- `/index.html`
- `/signup.html`
- `/login.html`
- `/dashboard.html`
- `/chatbot.html`
- `/summarizer.html`
- `/quiz.html`
