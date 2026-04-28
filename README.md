# @velocitykode/velocity-vite-plugin

Vite plugin for Velocity Framework apps. Owns the Vite-side half of the framework's asset wiring:

- writes `public/hot` while the dev server is running, with the resolved origin (protocol, host, port - including HMR overrides and IPv6 brackets)
- removes the hot file on close, signal, or production build, so prod never starts in dev mode
- sets the build defaults the framework's `bond/vite` Go helper expects: `base: '/build/'`, manifest on, `outDir: public/build`
- registers the `@ -> /resources/js` resolve alias

The Go side reads `public/hot` to decide between dev tags (pointing at the Vite server) and manifest-resolved tags (hashed asset URLs).

## Install

```bash
bun add -D @velocitykode/velocity-vite-plugin
# or
npm i -D @velocitykode/velocity-vite-plugin
```

## Usage

`vite.config.ts`:

```ts
import { defineConfig } from 'vite'
import velocity from '@velocitykode/velocity-vite-plugin'
import react from '@vitejs/plugin-react'
import inertia from '@inertiajs/vite'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [
    velocity('resources/js/app.tsx'),
    inertia({ ssr: false, pages: 'resources/js/pages' }),
    react(),
    tailwindcss(),
  ],
})
```

That single line replaces the manual `base`, `build.outDir`, `build.manifest`, `build.rollupOptions.input`, and resolve-alias config.

## Options

```ts
velocity({
  input: ['resources/js/app.tsx', 'resources/css/app.css'],
  publicDirectory: 'public',     // default
  buildDirectory: 'build',       // default - must match Go-side bond/vite
  hotFile: 'public/hot',         // default - must match Go-side bond/vite
  resolveAlias: {                // default { '@': '/resources/js' }; pass false to disable
    '@': '/resources/js',
    '~': '/resources/css',
  },
})
```

`input` accepts a single path, an array, or the full options object form.

## How the hot file works

While `vite dev` runs, the plugin writes the resolved dev origin (e.g. `http://localhost:5173`) into `public/hot`. The Go side checks for that file's existence on every request:

| State                | Go-side behavior                                    |
|----------------------|-----------------------------------------------------|
| `public/hot` exists  | emit `<script src="<hot-url>/...">` (dev mode)      |
| `public/hot` absent  | read `public/build/.vite/manifest.json`, emit hashed URLs |

The plugin removes the hot file on:

- normal close (`server.httpServer.close`)
- `SIGINT` / `SIGTERM` / `SIGHUP`
- process `exit`
- `vite build` (both `buildStart` and `closeBundle`)

That last sweep is the safety net: if a dev server is still running in another terminal when you `vite build`, the production bundle would otherwise ship next to a stale hot file and the deployed app would think it was in dev mode.

## License

MIT
