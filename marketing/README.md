# AI Startup School public marketing site

This directory is intentionally isolated from the Student Telegram Mini App and backend.

From the repository root, after the main repository dependencies are installed:

```bash
npm --prefix marketing run dev
npm --prefix marketing run build
npm --prefix marketing run preview
```

The marketing-local Vite configuration deliberately has no `/api` proxy: this public site can run without the Student App backend. Its production output is `marketing/dist/`.

The generated portal and journey artwork is stored in `marketing/assets`. Important headings, navigation, and calls to action remain crisp HTML text.
