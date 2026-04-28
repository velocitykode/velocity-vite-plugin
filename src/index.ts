// @velocitykode/vite-plugin
//
// Companion to the framework's bond/vite Go helper. The Go side reads
// public/hot to decide whether to emit dev tags (pointing at the running
// Vite server) or production tags (pointing at hashed assets in the
// manifest). This plugin is the only piece that knows the resolved dev
// origin - protocol, host, and port - and must therefore own the hot
// file's lifecycle.
//
// The user-facing API is intentionally minimal - pass an entrypoint,
// optionally override directories - so the common case stays a one-line
// plugin call in vite.config.ts.

import fs from "node:fs";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type {
	ConfigEnv,
	HmrOptions,
	Plugin,
	ResolvedConfig,
	ServerOptions,
	UserConfig,
} from "vite";

/** DevServerUrl is the origin written into the hot file. */
type DevServerUrl = `${"http" | "https"}://${string}:${number}`;

/**
 * Plugin options. Every field is optional except `input`; defaults
 * match the scaffold's `resources/js` + `public/build` layout.
 */
export interface VelocityPluginConfig {
	/** Entrypoint(s) for `build.rollupOptions.input`. Required in practice. */
	input: string | string[];

	/** Filesystem directory containing built assets and the hot file. */
	publicDirectory?: string;

	/** Subdirectory of publicDirectory that holds Vite's build output. */
	buildDirectory?: string;

	/** Absolute path to the hot file. Defaults to `${publicDirectory}/hot`. */
	hotFile?: string;

	/**
	 * Resource alias prefix. The default alias `@ -> /resources/js`
	 * matches the scaffold; pass `false` to disable.
	 */
	resolveAlias?: Record<string, string> | false;

	/**
	 * Reserved for forward-compat with a future full-reload watcher
	 * (Go templates, routes). Currently a no-op.
	 */
	refresh?: boolean;
}

interface ResolvedPluginConfig extends Required<Omit<VelocityPluginConfig, "resolveAlias" | "refresh">> {
	resolveAlias: Record<string, string> | false;
	refresh: boolean;
}

/**
 * Velocity Vite plugin.
 *
 *   import velocity from '@velocitykode/vite-plugin'
 *
 *   export default defineConfig({
 *     plugins: [velocity('resources/js/app.tsx')],
 *   })
 *
 * Returns a single plugin. A future SSR sub-plugin may extend this to
 * an array - keep your `plugins: [velocity(...)]` site shape stable.
 */
export default function velocity(
	config: string | string[] | VelocityPluginConfig,
): Plugin {
	const resolved = resolveConfig(config);
	return velocityPlugin(resolved);
}

function resolveConfig(
	config: string | string[] | VelocityPluginConfig,
): ResolvedPluginConfig {
	const raw: VelocityPluginConfig =
		typeof config === "string" || Array.isArray(config)
			? { input: config }
			: config;

	if (!raw.input) {
		throw new Error(
			"velocity-vite-plugin: `input` is required (the entrypoint(s) Vite will build).",
		);
	}

	const publicDirectory = (raw.publicDirectory ?? "public").trim().replace(
		/^\/+|\/+$/g,
		"",
	);
	const buildDirectory = (raw.buildDirectory ?? "build").trim().replace(
		/^\/+|\/+$/g,
		"",
	);

	return {
		input: raw.input,
		publicDirectory,
		buildDirectory,
		hotFile: raw.hotFile ?? path.join(publicDirectory, "hot"),
		resolveAlias:
			raw.resolveAlias === undefined
				? { "@": "/resources/js" }
				: raw.resolveAlias,
		refresh: raw.refresh ?? false,
	};
}

function velocityPlugin(config: ResolvedPluginConfig): Plugin {
	let viteConfig: ResolvedConfig;
	let exitHandlersBound = false;

	const clean = () => {
		if (fs.existsSync(config.hotFile)) {
			fs.rmSync(config.hotFile, { force: true });
		}
	};

	return {
		name: "velocitykode",
		enforce: "post",

		config(userConfig: UserConfig, _env: ConfigEnv): UserConfig {
			const aliases =
				config.resolveAlias === false
					? userConfig.resolve?.alias
					: mergeAliases(
							config.resolveAlias,
							userConfig.resolve?.alias as
								| Record<string, string>
								| Array<{ find: string | RegExp; replacement: string }>
								| undefined,
						);

			return {
				base: userConfig.base ?? `/${config.buildDirectory}/`,
				// Vite copies publicDir into outDir at build time; for our
				// layout outDir IS inside publicDir, which would create
				// recursion. Disable publicDir to break the cycle.
				publicDir: userConfig.publicDir ?? false,
				build: {
					manifest: userConfig.build?.manifest ?? "manifest.json",
					outDir:
						userConfig.build?.outDir ??
						`${config.publicDirectory}/${config.buildDirectory}`,
					rollupOptions: {
						input:
							userConfig.build?.rollupOptions?.input ??
							(Array.isArray(config.input) ? config.input : [config.input]),
					},
				},
				server: {
					origin: userConfig.server?.origin ?? "__velocity_vite_placeholder__",
				},
				resolve: {
					alias: aliases,
				},
			};
		},

		configResolved(resolved) {
			viteConfig = resolved;
		},

		configureServer(server) {
			const httpServer = server.httpServer;
			if (!httpServer) return;

			const writeHot = () => {
				const address = httpServer.address();
				if (!address || typeof address === "string") return;
				const url = resolveDevServerUrl(address, server.config.server, viteConfig.server.hmr);
				try {
					fs.mkdirSync(path.dirname(config.hotFile), { recursive: true });
					fs.writeFileSync(config.hotFile, url);
				} catch (err) {
					server.config.logger.warn(
						`[velocity] failed to write ${config.hotFile}: ${(err as Error).message}`,
					);
				}
			};

			if (httpServer.listening) {
				writeHot();
			} else {
				httpServer.once("listening", writeHot);
			}

			httpServer.on("close", clean);

			// Process-level safety net. Vite's own teardown runs `close`
			// for clean shutdowns, but Ctrl+C / kill / hangup paths skip
			// it on some platforms. Bind once; multiple servers in one
			// process (rare) share the same handlers.
			if (!exitHandlersBound) {
				exitHandlersBound = true;
				const onSignal = () => {
					clean();
					process.exit();
				};
				process.on("exit", clean);
				process.on("SIGINT", onSignal);
				process.on("SIGTERM", onSignal);
				process.on("SIGHUP", onSignal);
			}
		},

		// Build path: ensure no stale hot file from a still-running dev
		// server confuses production. Symmetrical pre/post sweep.
		buildStart() {
			if (viteConfig?.command === "build") clean();
		},
		closeBundle() {
			if (viteConfig?.command === "build") clean();
		},
	};
}

/**
 * resolveDevServerUrl collapses HMR config + bound socket into a single
 * origin string. Priority order:
 *
 *   1. server.hmr.host / server.hmr.protocol / server.hmr.clientPort
 *      win when set (HMR may run on a different scheme/port behind a
 *      reverse proxy).
 *   2. Otherwise server.host wins as the host (string only - booleans
 *      mean "listen everywhere", which a browser cannot dial).
 *   3. Otherwise the bound socket's address. Wildcards become localhost
 *      (a browser cannot dial 0.0.0.0); IPv6 numeric addresses get
 *      bracketed.
 *
 * Protocol: hmr.protocol if set, else 'https' if server.https, else http.
 */
function resolveDevServerUrl(
	address: AddressInfo,
	server: ServerOptions,
	hmr: HmrOptions | boolean | undefined,
): DevServerUrl {
	const hmrCfg: HmrOptions = typeof hmr === "object" && hmr !== null ? hmr : {};

	let protocol: "http" | "https";
	if (hmrCfg.protocol === "wss") protocol = "https";
	else if (hmrCfg.protocol === "ws") protocol = "http";
	else if (server.https) protocol = "https";
	else protocol = "http";

	let host: string;
	if (typeof hmrCfg.host === "string" && hmrCfg.host) {
		host = hmrCfg.host;
	} else if (typeof server.host === "string" && server.host) {
		host = server.host;
	} else if (isWildcard(address.address)) {
		host = "localhost";
	} else if (address.family === "IPv6" || (address.family as unknown) === 6) {
		host = `[${address.address}]`;
	} else {
		host = address.address;
	}

	const port = hmrCfg.clientPort ?? address.port;

	return `${protocol}://${host}:${port}`;
}

function isWildcard(host: string): boolean {
	return host === "0.0.0.0" || host === "::" || host === "" || host === "*";
}

function mergeAliases(
	defaults: Record<string, string>,
	user:
		| Record<string, string>
		| Array<{ find: string | RegExp; replacement: string }>
		| undefined,
): Record<string, string> | Array<{ find: string | RegExp; replacement: string }> {
	if (user === undefined) return defaults;
	// Array-form aliases (Vite's `Array<Alias>`): user wins, append our
	// defaults that don't conflict.
	if (Array.isArray(user)) {
		const userKeys = new Set(user.map((a) => String(a.find)));
		const merged = [...user];
		for (const [find, replacement] of Object.entries(defaults)) {
			if (!userKeys.has(find)) merged.push({ find, replacement });
		}
		return merged;
	}
	return { ...defaults, ...user };
}

