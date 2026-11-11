import { DEFAULT_HOSTED_APP_URL } from "@t3tools/shared/connectAuth";
import { afterEach, expect, it, vi } from "vite-plus/test";

import appleAppSiteAssociation from "../web/public/.well-known/apple-app-site-association.json";
import assetLinks from "../web/public/.well-known/assetlinks.json";

// Keep config parsing independent of local env files and build credentials.
vi.mock("../../scripts/lib/public-config.ts", () => ({
  // app.config.ts copies these into process.env, so unset names stay out (not "undefined").
  loadRepoEnv: () =>
    Object.fromEntries(
      ["APP_VARIANT", "AIVA_IOS_IDENTITY", "AIVA_IOS_BUILD_NUMBER", "AIVA_IOS_WIDGETS"].flatMap(
        (name) => (process.env[name] === undefined ? [] : [[name, process.env[name]]]),
      ),
    ),
}));

afterEach(() => {
  vi.unstubAllEnvs();
});

async function loadConfig(variant: string | undefined) {
  vi.resetModules();
  vi.stubEnv("APP_VARIANT", variant);
  return (await import("./app.config.ts")).default;
}

it.each(["prod", ""])("rejects APP_VARIANT=%j before selecting production IDs", async (value) => {
  await expect(loadConfig(value)).rejects.toThrow(
    "APP_VARIANT must be development, preview, or production.",
  );
});

it.each([
  [undefined, "com.t3tools.t3code"],
  ["development", "com.t3tools.t3code.dev"],
  ["preview", "com.t3tools.t3code.preview"],
  ["production", "com.t3tools.t3code"],
])("keeps the iOS and Android identifiers for APP_VARIANT=%j", async (value, identifier) => {
  const config = await loadConfig(value);
  expect(config.ios?.bundleIdentifier).toBe(identifier);
  expect(config.android?.package).toBe(identifier);
  // Copied thread links open this app only while app.t3.codes lists it.
  const host = new URL(DEFAULT_HOSTED_APP_URL).host;
  expect(config.ios?.associatedDomains).toContain(`applinks:${host}`);
  expect(appleAppSiteAssociation.applinks.details[0]?.appIDs).toContain(
    `${config.ios?.appleTeamId}.${identifier}`,
  );
  expect(config.android?.intentFilters?.[0]?.data).toEqual([
    { scheme: "https", host, pathPrefix: "/threads/" },
  ]);
  expect(assetLinks.map((link) => link.target.package_name)).toContain(identifier);
});

type PluginEntry = string | [string, Record<string, unknown>];

function pluginOptions(config: Awaited<ReturnType<typeof loadConfig>>, name: string) {
  const entry = (config.plugins as PluginEntry[] | undefined)?.find(
    (plugin) => Array.isArray(plugin) && plugin[0] === name,
  );
  return Array.isArray(entry) ? entry[1] : undefined;
}

async function loadAivaConfig(buildNumber?: string) {
  vi.stubEnv("AIVA_IOS_IDENTITY", "1");
  vi.stubEnv("AIVA_IOS_BUILD_NUMBER", buildNumber);
  return loadConfig("production");
}

it("builds the iPhone app under old Aiva's App Store identity", async () => {
  const config = await loadAivaConfig("100123");
  expect(config.name).toBe("Aiva");
  expect(config.ios?.bundleIdentifier).toBe("app.aivacode.moltenmouse");
  expect(config.ios?.appleTeamId).toBe("8273XQ7764");
  expect(config.ios?.buildNumber).toBe("100123");
  // Old Aiva's App IDs have App Groups and Push only; t3's domains and Apple sign-in are not ours.
  expect(config.ios?.associatedDomains).toBeUndefined();
  expect(pluginOptions(config, "@clerk/expo")?.appleSignIn).toBe(false);
  expect(config.ios?.entitlements?.["keychain-access-groups"]).toEqual([
    "$(AppIdentifierPrefix)app.aivacode.moltenmouse",
  ]);
  const sharing = pluginOptions(config, "expo-sharing")?.ios as Record<string, unknown>;
  expect(sharing.extensionBundleIdentifier).toBe("app.aivacode.moltenmouse.share");
  expect(sharing.appGroupId).toBe("group.app.aivacode.moltenmouse");
  const widgets = pluginOptions(config, "expo-widgets");
  expect(widgets?.bundleIdentifier).toBe("app.aivacode.moltenmouse.widgets");
  expect(widgets?.groupIdentifier).toBe("group.app.aivacode.moltenmouse");
  // t3's EAS updates must never reach an Aiva-signed binary.
  expect(config.updates?.enabled).toBe(false);
});

it("leaves the widgets extension out with AIVA_IOS_WIDGETS=0", async () => {
  vi.stubEnv("AIVA_IOS_WIDGETS", "0");
  const config = await loadAivaConfig("100123");
  expect(pluginOptions(config, "expo-widgets")).toBeUndefined();
  expect(config.plugins).not.toContain("./plugins/withWidgetLogoAsset.cjs");
  expect(config.ios?.bundleIdentifier).toBe("app.aivacode.moltenmouse");
});

it("leaves t3's identity alone without AIVA_IOS_IDENTITY", async () => {
  const config = await loadConfig("production");
  expect(config.ios?.appleTeamId).toBe("ARK85ZXQ4Z");
  expect(config.ios?.buildNumber).toBeUndefined();
  expect(pluginOptions(config, "@clerk/expo")?.appleSignIn).toBe(true);
});

it.each(["0", "12a", "-3"])("rejects AIVA_IOS_BUILD_NUMBER=%j", async (value) => {
  await expect(loadAivaConfig(value)).rejects.toThrow(
    "AIVA_IOS_BUILD_NUMBER must be a positive integer.",
  );
});
