# ![Contributing](https://i.imgur.com/wCtXTvx.png)  ![toro](https://i.imgur.com/dnCpbi0.png)

First off, thank you for thinking about contributing, it helps make Lokal way better for everyone. 

The more people that help (because I can only do so much), the more this program can truly be useful to others. 



### *Before you start, please read through this guide to ensure a smooth development process.*

---

## Development Environment

### Prerequisites
- **Node.js:** v18 or higher.
- **Git:** To clone and manage versions.
- **Build Tools:** Since we use `better-sqlite3` (a native C++ module), you may need:
  - **Windows:** `npm install --global windows-build-tools` or Visual Studio Build Tools.
  - **macOS:** Xcode Command Line Tools (`xcode-select --install`).
  - **Linux:** `build-essential` and `python3`.

### Optional but Recommended
- **yt-dlp & ffmpeg:** Required if you are testing/debugging the Downloader. Ensure they are in your PATH or placed in the project root.

---

## Getting Started

1. **Fork the Repository** on GitHub.
2. **Clone your fork locally:**
```bash
git clone https://github.com/lokal-music/Desktop.git
cd Desktop
npm install
```

### Working on the Desktop App (Electron)

Lokal uses separate builds for SQLite depending on the environment. For Desktop development:

```bash
npm run rebuild:electron
npm run dev

```

### Working on Web Mode (Express)

If you are contributing to the web server or remote API:

```bash
cp .env.example .env
npm run rebuild:web
npm run dev:web

```

---

## Project Structure

* `electron/`: Main process logic.
* `ipc/`: This is where most stuff happens. (Scanning, Downloader, Database).
* `src/`: React Frontend (Vite).
* `store/`: Zustand state management (Player logic, UI state).
* `server/`: Express routes for the Web Mode.

---

## Contribution Rules

### 1. Branching

Please create a feature branch for your work:
`git checkout -b feat/your-feature-name` or `git checkout -b fix/issue-name`

### 2. Code Style

* We use **Tailwind CSS** for styling. Please avoid adding raw CSS files unless absolutely necessary.
* Use **Lucide React** for icons to keep the UI consistent.
* Ensure your code is mostly clean and commented, especially in the IPC handlers.
* *^^^ (it's okay if its not "perfect", just make sure I can tell where you put new stuff)*

### 3. Database Changes

If you modify the database schema:

1. Update the initialization logic in `electron/ipc/db.js`.
2. Clearly state the schema change in your Pull Request description (as to avoid issues when implementing).

### 4. Pull Requests

* Provide a clear description of the changes.
* Include screenshots or GIFs if the UI has changed.
* Link the PR to any related [Issues](https://github.com/lokal-music/Desktop/issues).

---

## Reporting Bugs

If you find a bug but don't have time to fix it, please [open an issue](https://github.com/lokal-music/Desktop/issues) using our **Bug Report** template. Be sure to include:

* Your OS and Lokal version.
* Console logs (found via `Ctrl+Shift+I` in the app).

## Feature Requests

Have an idea? Open an issue with the **Feature Request** tag! We'd love to hear how to make Lokal an even player.

---

## License

By contributing to Lokal, you agree that your contributions will be licensed under the project's [MIT License](https://www.google.com/search?q=./LICENSE).

