# ElaLitPages Game Launcher

A Node.js and Express launcher for running open-source game repositories in a browser. Native games are exposed through a shared X11/noVNC display, while browser games such as BitLife load their local WebGL page directly.

## Run locally

```bash
npm install
npm start
```

Open `http://localhost:3000`.

## Deploy to Render

1. Push this repository to a public GitHub repository.
2. In Render, choose **New +** and **Blueprint**.
3. Select the GitHub repository.
4. Render will use `render.yaml` and build the included `Dockerfile`.

The launcher clones requested game repositories into the running container. Those files are runtime data and are intentionally excluded from Git.

## Notes

- The free Render plan may sleep when idle and has limited CPU, memory, and disk space.
- Large native game builds may exceed free-plan limits. Browser/WebGL games are the lightest to run.
- A persistent disk is needed if cloned game repositories should survive redeploys.
