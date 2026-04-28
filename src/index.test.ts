// Smoke tests for the plugin's pure logic. We don't spin up a real
// Vite dev server here - that would require a fixture and bind a port,
// which is overkill for what we're testing. Instead we exercise the
// `config()` hook (pure function over user config) and the internal
// origin resolution (pure function over an AddressInfo).
//
// Run with: node --test --experimental-strip-types src/index.test.ts
//
// This stays compile-time-clean for tsc but tsc is not run on tests
// (excluded in tsconfig). Node 22 strips TS types at runtime.

import test from "node:test";
import assert from "node:assert/strict";
import type { Plugin, UserConfig } from "vite";

import velocity from "./index.ts";

// callConfig invokes the plugin's `config` hook and returns its result.
// The hook can return undefined, an object, or a Promise - we only
// support the object form, which is what our plugin returns.
function callConfig(plugin: Plugin, userConfig: UserConfig = {}): UserConfig {
	const hook = plugin.config;
	assert.ok(hook, "plugin.config hook is required");
	const fn = typeof hook === "function" ? hook : hook.handler;
	const result = fn.call(plugin, userConfig, { command: "build", mode: "production" });
	assert.ok(result && typeof result === "object" && !(result instanceof Promise));
	return result as UserConfig;
}

test("plugin shape: name and enforce", () => {
	const p = velocity("resources/js/app.tsx");
	assert.equal(p.name, "velocitykode");
	assert.equal(p.enforce, "post");
});

test("input is required", () => {
	assert.throws(
		// @ts-expect-error - testing the runtime guard
		() => velocity({}),
		/input.*required/i,
	);
});

test("config() sets base, outDir, manifest, input from defaults", () => {
	const p = velocity("resources/js/app.tsx");
	const cfg = callConfig(p);
	assert.equal(cfg.base, "/build/");
	assert.equal(cfg.publicDir, false);
	assert.equal(cfg.build?.outDir, "public/build");
	assert.equal(cfg.build?.manifest, "manifest.json");
	assert.deepEqual(cfg.build?.rollupOptions?.input, ["resources/js/app.tsx"]);
});

test("config() respects user-supplied base/outDir/manifest/input", () => {
	const p = velocity("resources/js/app.tsx");
	const cfg = callConfig(p, {
		base: "/static/",
		build: {
			outDir: "dist",
			manifest: false,
			rollupOptions: { input: ["x.tsx"] },
		},
	});
	assert.equal(cfg.base, "/static/");
	assert.equal(cfg.build?.outDir, "dist");
	assert.equal(cfg.build?.manifest, false);
	assert.deepEqual(cfg.build?.rollupOptions?.input, ["x.tsx"]);
});

test("config() honors custom buildDirectory and publicDirectory", () => {
	const p = velocity({
		input: "x.tsx",
		publicDirectory: "static",
		buildDirectory: "assets",
	});
	const cfg = callConfig(p);
	assert.equal(cfg.base, "/assets/");
	assert.equal(cfg.build?.outDir, "static/assets");
});

test("config() merges default '@' alias with user object aliases", () => {
	const p = velocity("x.tsx");
	const cfg = callConfig(p, {
		resolve: { alias: { foo: "/bar" } },
	});
	assert.deepEqual(cfg.resolve?.alias, {
		"@": "/resources/js",
		foo: "/bar",
	});
});

test("config() preserves user array-form aliases and appends defaults", () => {
	const p = velocity("x.tsx");
	const cfg = callConfig(p, {
		resolve: {
			alias: [{ find: "foo", replacement: "/bar" }],
		},
	});
	const aliases = cfg.resolve?.alias as Array<{
		find: string | RegExp;
		replacement: string;
	}>;
	assert.ok(Array.isArray(aliases));
	assert.equal(aliases.length, 2);
	assert.equal(aliases[0]?.find, "foo");
	assert.equal(aliases[1]?.find, "@");
	assert.equal(aliases[1]?.replacement, "/resources/js");
});

test("config() emits placeholder server.origin so listen-time resolution wins", () => {
	const p = velocity("x.tsx");
	const cfg = callConfig(p);
	assert.equal(cfg.server?.origin, "__velocity_vite_placeholder__");
});

test("input as array is preserved verbatim", () => {
	const p = velocity(["a.tsx", "b.tsx"]);
	const cfg = callConfig(p);
	assert.deepEqual(cfg.build?.rollupOptions?.input, ["a.tsx", "b.tsx"]);
});

test("resolveAlias: false disables the default '@' alias", () => {
	const p = velocity({ input: "x.tsx", resolveAlias: false });
	const cfg = callConfig(p);
	assert.equal(cfg.resolve?.alias, undefined);
});
