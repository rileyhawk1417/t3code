import { TAILNET_APP_CAPABILITY, tailnetGrantSnippet } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NetService from "@t3tools/shared/Net";
import {
  isTailscaleIpv4Address,
  readTailscaleStatus,
  readTailscaleWhois,
  type TailscaleStatus,
} from "@t3tools/tailscale";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { Command, Flag, GlobalFlag, Prompt } from "effect/cli";
import * as CliError from "effect/cli/CliError";

import packageJson from "../../package.json" with { type: "json" };
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { REQUIRE_GRANT_FILE } from "../auth/TailnetSignIn.ts";
import * as BootService from "../cloud/bootService.ts";
import * as CliState from "../cloud/CliState.ts";
import { CLOUD_LINK_REVOKED } from "../cloud/config.ts";
import { hasCloudPublicConfig } from "../cloud/publicConfig.ts";
import { compareExactServiceVersions } from "../cloud/serviceProtocol.ts";
import * as ServerConfig from "../config.ts";
import { isProcessAlive, readPersistedServerRuntimeState } from "../serverRuntimeState.ts";
import { renderTerminalQrCode } from "../startupAccess.ts";
import {
  isSupportedTailscaleVersion,
  MINIMUM_TAILSCALE_VERSION,
} from "../tailscale/TailscaleHost.ts";
import { projectLocationFlags, resolveCliAuthConfig } from "./config.ts";
import {
  connectSubcommands,
  disconnectCloud,
  headlessFlag,
  linkEnvironmentForConnect,
  runCloudCommand,
  waitForReachability,
} from "./connect.ts";
import { resolveHostCliCommand } from "./invocation.ts";
import * as CliService from "./service.ts";
import { turnOnRequireGrant } from "./tailscale.ts";

type Route = "tailscale" | "connect" | "lan";
type Routes = Readonly<Record<Route, boolean>>;
type RouteFlags = Readonly<Record<Route, Option.Option<boolean>>>;

const upError = (reason: string) => new CliError.UserError({ cause: reason, userMessage: reason });

// The values the server's Config.Boolean accepts.
const parseBoolean = (value: string | undefined) =>
  value === undefined
    ? undefined
    : ["true", "yes", "on", "1", "y"].includes(value)
      ? true
      : ["false", "no", "off", "0", "n"].includes(value)
        ? false
        : undefined;

/** What a running service read from `service.env` when it started. */
const serviceSettings = (entries: Readonly<Record<string, string>>, installed: boolean) => ({
  // An installed service with no T3CODE_LAN keeps the old default: on.
  lan: parseBoolean(entries.T3CODE_LAN) ?? installed,
  tailscale: parseBoolean(entries.T3CODE_TAILSCALE_SIGN_IN) ?? false,
  owner: entries.T3CODE_TAILSCALE_OWNER ?? null,
  port: entries.T3CODE_PORT ?? String(ServerConfig.DEFAULT_PORT),
  tailscaleServe: parseBoolean(entries.T3CODE_TAILSCALE_SERVE) ?? false,
});

type ServiceSettings = ReturnType<typeof serviceSettings>;

const sameSettings = (a: ServiceSettings, b: ServiceSettings) =>
  a.lan === b.lan &&
  a.tailscale === b.tailscale &&
  a.owner === b.owner &&
  a.port === b.port &&
  a.tailscaleServe === b.tailscaleServe;

/** How other devices reach this machine now. */
interface Setup {
  readonly service: BootService.BootServiceStatus;
  /** Null in builds without T3 Connect. Off when T3 Connect revoked the link. */
  readonly connect: boolean | null;
  /** T3 Connect revoked the link; `t3 connect` links again. */
  readonly connectRevoked: boolean;
  readonly entries: Readonly<Record<string, string>>;
  readonly settings: ServiceSettings;
  readonly lanFromOldDefault: boolean;
  readonly requireGrant: boolean;
  readonly host: string | undefined;
}

const readSetup = Effect.fn("cli.up.read_setup")(function* () {
  const { baseDir, stateDir } = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const service = yield* (yield* BootService.BootService).status;
  const { entries } = yield* CliService.readServiceEnv(baseDir);
  const connectRevoked =
    hasCloudPublicConfig &&
    Option.isSome(yield* (yield* ServerSecretStore.ServerSecretStore).get(CLOUD_LINK_REVOKED));
  const connect = hasCloudPublicConfig
    ? (yield* CliState.readCliDesiredCloudLink) &&
      (yield* CliState.readCliDesiredLinkMode) === "managed" &&
      !connectRevoked
    : null;
  return {
    service,
    connect,
    connectRevoked,
    entries,
    settings: serviceSettings(entries, service.installed),
    lanFromOldDefault: entries.T3CODE_LAN === undefined && service.installed,
    requireGrant: yield* fs.exists(path.join(stateDir, REQUIRE_GRANT_FILE)),
    host: entries.T3CODE_HOST,
  } satisfies Setup;
});

/**
 * The routes `t3 up` starts from. With no route flag it asks about every
 * route it can offer, starting a machine with no service from Tailscale when
 * it runs here, else T3 Connect. Any route flag means it asks nothing and
 * keeps the routes not named as they are.
 */
export const planRoutes = (
  setup: {
    readonly installed: boolean;
    readonly current: Routes;
    /** False where this machine cannot offer the route. */
    readonly available: Readonly<Record<"tailscale" | "connect", boolean>>;
  },
  flags: RouteFlags,
) => {
  const ask = [flags.tailscale, flags.connect, flags.lan].every(Option.isNone);
  const start: Routes =
    ask && !setup.installed
      ? {
          tailscale: setup.available.tailscale,
          connect: setup.available.connect && !setup.available.tailscale,
          lan: false,
        }
      : setup.current;
  return {
    routes: {
      tailscale: Option.getOrElse(flags.tailscale, () => start.tailscale),
      connect: Option.getOrElse(flags.connect, () => start.connect),
      lan: Option.getOrElse(flags.lan, () => start.lan),
    } satisfies Routes,
    ask: ask
      ? (["tailscale", "connect", "lan"] as const).filter(
          // A route that is on can always be turned off.
          (route) => route === "lan" || setup.available[route] || setup.current[route],
        )
      : [],
  };
};

const CHOICES = {
  tailscale: {
    title: "Tailscale",
    description:
      "Your devices on your tailnet sign in with no code. Once your tailnet policy grants this app, it decides who gets in.",
  },
  connect: {
    title: "T3 Connect",
    description: "Sign in with your T3 account on each device. Works from anywhere.",
  },
  lan: {
    title: "Local network",
    description:
      "Devices on your Wi-Fi, wired network, or tailnet connect directly. Anyone on them can reach the port, and a pairing code is the only lock.",
  },
} satisfies Record<Route, { readonly title: string; readonly description: string }>;

const formatSetup = (setup: Setup) => {
  const { service, settings } = setup;
  const rows: ReadonlyArray<readonly [string, string]> = [
    [
      "Background service",
      !service.supported
        ? "not available on this machine"
        : service.installed
          ? `installed · t3@${service.installedVersion ?? packageJson.version}`
          : "not installed",
    ],
    [
      "Tailscale",
      !settings.tailscale
        ? "off"
        : setup.requireGrant
          ? `on, only devices your tailnet policy grants ${TAILNET_APP_CAPABILITY}`
          : `on, devices your policy grants ${TAILNET_APP_CAPABILITY}, else your own untagged devices`,
    ],
    ...(setup.connect === null
      ? []
      : [
          [
            "T3 Connect",
            setup.connect
              ? "on"
              : setup.connectRevoked
                ? "off, T3 Connect revoked this link. Run `t3 connect` to link again."
                : "off",
          ] as const,
        ]),
    [
      "Local network",
      setup.host !== undefined
        ? `decided by T3CODE_HOST=${setup.host} in service.env`
        : setup.lanFromOldDefault
          ? "on, the old default. Turn it off with `t3 up --no-lan`."
          : settings.lan
            ? "on"
            : settings.tailscale
              ? "off, LAN connections refused"
              : "off",
    ],
  ];
  return rows.map(([label, value]) => `  ${label.padEnd(20)}${value}`).join("\n");
};

const formatNextSteps = (routes: Routes) =>
  [
    ...(routes.connect
      ? ["On your phone or another computer, sign in to T3 Connect with the same account."]
      : []),
    ...(routes.lan
      ? ["On a device on this network, add this machine with a code from `t3 pair`."]
      : []),
    ...(routes.connect || routes.lan || routes.tailscale
      ? []
      : ["No other device can reach this machine. Run `t3` to use T3 Code here."]),
    "Change this with `t3 up`. See it with `t3 status`.",
  ].join("\n");

const interactiveTerminal = () => Boolean(process.stdin.isTTY && process.stdout.isTTY);

interface Owner {
  readonly userId: string;
  readonly login: string | null;
}

const loginOf = (status: TailscaleStatus, userId: string | null) =>
  status.users.find((user) => user.userId === userId)?.loginName ?? null;

const ownerForLogin = (status: TailscaleStatus, login: string) => {
  const wanted = login.trim().toLowerCase();
  const user = status.users.find((candidate) => candidate.loginName?.toLowerCase() === wanted);
  return user === undefined
    ? Effect.fail(
        upError(
          `No Tailscale user with the login ${login.trim()} is visible from this host. Check the spelling, or sign in to Tailscale on one of that user's devices first.`,
        ),
      )
    : Effect.succeed({ userId: user.userId, login: user.loginName } satisfies Owner);
};

/** The SSH client's user, when it connects over the tailnet from one of its own devices. */
const proposeSshOwner = Effect.fn("cli.up.proposeSshOwner")(function* () {
  const env = yield* HostProcess.Environment;
  const clientAddress = env.SSH_CONNECTION?.trim().split(/\s+/u)[0];
  if (clientAddress === undefined || !isTailscaleIpv4Address(clientAddress)) {
    return Option.none<Owner>();
  }
  const node = yield* readTailscaleWhois(clientAddress).pipe(Effect.option);
  return Option.filter(
    node,
    (value) => value.tags.length === 0 && value.sharerUserId === null,
  ).pipe(Option.map((value): Owner => ({ userId: value.userId, login: value.loginName })));
});

const resolveOwner = Effect.fn("cli.up.resolveOwner")(function* (
  status: TailscaleStatus,
  ownerLogin: Option.Option<string>,
) {
  if (status.selfTags.length === 0) {
    if (status.selfUserId === null) {
      return yield* upError("Tailscale did not report this host's user.");
    }
    const own: Owner = { userId: status.selfUserId, login: loginOf(status, status.selfUserId) };
    if (Option.isSome(ownerLogin)) {
      const requested = yield* ownerForLogin(status, ownerLogin.value);
      if (requested.userId !== own.userId) {
        return yield* upError(
          `This host is not tagged, so its owner is its own Tailscale user (${own.login ?? own.userId}). Drop --owner, or tag the host first.`,
        );
      }
    }
    return own;
  }
  if (Option.isSome(ownerLogin)) return yield* ownerForLogin(status, ownerLogin.value);
  if (!interactiveTerminal()) {
    return yield* upError(
      "This host is tagged, so it has no Tailscale user. Pass --owner <login>.",
    );
  }
  const proposed = yield* proposeSshOwner();
  if (Option.isSome(proposed)) {
    const accepted = yield* Prompt.run(
      Prompt.Confirm({
        message: `This host is tagged. Make ${proposed.value.login ?? proposed.value.userId}, the user you connect from, its owner?`,
        initial: true,
      }),
    );
    if (accepted) return proposed.value;
  }
  const login = yield* Prompt.run(
    Prompt.String({ message: "This host is tagged. Tailscale login of its owner:" }),
  );
  return yield* ownerForLogin(status, login);
});

/** Tailscale's state here, or why Tailscale sign-in cannot work on this machine. */
const checkTailscale = Effect.fn("cli.up.checkTailscale")(function* () {
  const status = yield* readTailscaleStatus("active").pipe(Effect.option);
  if (Option.isNone(status)) {
    return {
      ok: false,
      reason: "Tailscale did not answer. Install it and run `sudo tailscale up`.",
    } as const;
  }
  const { value } = status;
  if (value.backendState !== "Running") {
    return {
      ok: false,
      reason: `Tailscale is ${value.backendState ?? "not running"}. Run \`sudo tailscale up\`.`,
    } as const;
  }
  if (value.userspaceNetworking === true) {
    return {
      ok: false,
      reason:
        "Tailscale uses userspace networking here, which is common in LXC and other containers. Tailnet connections then reach T3 Code from 127.0.0.1, so it cannot tell which device connects and Tailscale sign-in cannot work. Give the container /dev/net/tun and run tailscaled without --tun=userspace-networking.",
    } as const;
  }
  if (!isSupportedTailscaleVersion(value.version)) {
    return {
      ok: false,
      reason: `Tailscale ${value.version ?? "(unknown version)"} is too old for Tailscale sign-in. Update to ${MINIMUM_TAILSCALE_VERSION} or newer.`,
    } as const;
  }
  const address = value.tailnetIpv4Addresses[0];
  if (address === undefined) {
    return { ok: false, reason: "Tailscale reported no IPv4 address for this host." } as const;
  }
  return { ok: true, status: value, address } as const;
});

const indent = (text: string) =>
  text
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");

/**
 * Discovery probes only the default port, so `t3 up` pins it rather than let
 * the server fall back to the next free one. A port the user set is kept.
 */
export const upPortCheck = (input: {
  readonly configuredPort: string | undefined;
  /** Whether the port the service will use, configured or default, is free. */
  readonly portFree: boolean;
  /** The live server this T3 home already runs, if any. */
  readonly running: { readonly port: number; readonly serviceManaged: boolean } | null;
}): "ok" | "taken" | "custom" | "manual" => {
  // The service cannot take this home over from a server started by hand.
  if (input.running !== null && !input.running.serviceManaged) return "manual";
  const port =
    input.configuredPort === undefined ? ServerConfig.DEFAULT_PORT : Number(input.configuredPort);
  if (!input.portFree && input.running?.port !== port) return "taken";
  return port === ServerConfig.DEFAULT_PORT ? "ok" : "custom";
};

/** The `service.env` entries Tailscale sign-in needs, after checking the port and owner. */
const tailscaleEntries = Effect.fn("cli.up.tailscale_entries")(function* (
  tailscale: { readonly status: TailscaleStatus },
  flags: { readonly owner: Option.Option<string>; readonly tailscaleServe: Option.Option<boolean> },
  requireGrant: boolean,
) {
  const config = yield* ServerConfig.ServerConfig;
  const { entries, path: serviceEnvPath } = yield* CliService.readServiceEnv(config.baseDir);
  const tagged = tailscale.status.selfTags.length > 0;
  // With grants required, the policy names who gets in, so the box needs no owner.
  const owner = requireGrant ? null : yield* resolveOwner(tailscale.status, flags.owner);
  const configuredPort = entries.T3CODE_PORT;
  const port = Number(configuredPort ?? ServerConfig.DEFAULT_PORT);
  const net = yield* NetService.NetService;
  const runtime = yield* readPersistedServerRuntimeState(config.serverRuntimeStatePath);
  const running = Option.filter(runtime, (state) => isProcessAlive(state.pid));
  const portCheck = upPortCheck({
    configuredPort,
    portFree: yield* net.canListenOnHost(port, "0.0.0.0"),
    running: Option.match(running, {
      onNone: () => null,
      onSome: (state) => ({ port: state.port, serviceManaged: state.serviceManaged === true }),
    }),
  });
  if (portCheck === "manual") {
    return yield* upError(
      `A T3 Code server you started by hand is running for ${config.baseDir}. Stop it, then run t3 up again.`,
    );
  }
  if (portCheck === "taken") {
    return yield* upError(
      `Port ${port} is in use by another program. Free it, or set another T3CODE_PORT in ${serviceEnvPath} and add this box by name and port.`,
    );
  }
  if (portCheck === "custom") {
    yield* Console.warn(
      `${serviceEnvPath} sets T3CODE_PORT=${configuredPort}. Other devices find boxes only on port ${ServerConfig.DEFAULT_PORT}, so add this one by name and port.`,
    );
  }
  return {
    owner,
    port,
    entries: {
      T3CODE_TAILSCALE_SIGN_IN: "true",
      T3CODE_PORT: configuredPort ?? String(ServerConfig.DEFAULT_PORT),
      // The user ID, never the login: logins can be renamed.
      ...(owner === null ? {} : { T3CODE_TAILSCALE_OWNER: tagged ? owner.userId : undefined }),
      ...Option.match(flags.tailscaleServe, {
        onNone: () => ({}),
        onSome: (on) => ({ T3CODE_TAILSCALE_SERVE: on ? "true" : undefined }),
      }),
    },
  };
});

const formatTailscale = (
  tailscale: { readonly status: TailscaleStatus; readonly address: string },
  owner: Owner | null,
  port: number,
  requireGrant: boolean,
) => {
  const { status, address } = tailscale;
  const tagged = status.selfTags.length > 0;
  const directUrl = `http://${address}:${port}`;
  const dst = status.selfTags[0] ?? address;
  // The owner, or the host's own user on an untagged box. A tagged box's user is the
  // shared "tagged-devices" user, which no policy can name, so it gets a placeholder.
  const src =
    owner?.login ??
    (tagged || status.selfUserId === null ? null : loginOf(status, status.selfUserId)) ??
    "you@example.com";
  return [
    `Tailscale: signed in as ${status.magicDnsName ?? address}${
      owner === null ? "" : `, owned by ${owner.login ?? owner.userId}`
    }.`,
    `Scan to add this machine on your phone (${directUrl}):`,
    renderTerminalQrCode(directUrl),
    "Your other devices on the tailnet find it on their own.",
    "",
    ...(requireGrant
      ? [
          "No device gets in until your tailnet policy grants it. For example:",
          indent(tailnetGrantSnippet(src, dst, port)),
          "Turn this off with: t3 tailscale require-grant off",
        ]
      : [
          "Tip: any untagged device you own can sign in here, including agents running on it.",
          "To decide access in your tailnet policy instead, add a grant like this one,",
          "and this machine lets in only granted devices. To require one now,",
          "run `t3 tailscale require-grant on`.",
          indent(tailnetGrantSnippet(src, dst, port)),
        ]),
    "",
  ].join("\n");
};

const setUp = Effect.fn("cli.up")(function* (
  flags: RouteFlags & {
    readonly baseDir: Option.Option<string>;
    readonly yes: boolean;
    readonly headless: boolean;
    readonly owner: Option.Option<string>;
    readonly requireGrant: boolean;
    readonly tailscaleServe: Option.Option<boolean>;
  },
) {
  // The service runs under `systemctl --user`, so root would set up a separate root install.
  if ((yield* HostProcess.UserId) === 0) {
    const env = yield* HostProcess.Environment;
    return yield* upError(
      `Run t3 up as the user who should own T3 Code, not as root:\n  sudo -iu ${env.SUDO_USER ?? "<user>"} npx t3 up`,
    );
  }
  const config = yield* ServerConfig.ServerConfig;
  const service = yield* BootService.BootService;
  const before = yield* readSetup();
  if (before.connect === null && Option.getOrElse(flags.connect, () => false)) {
    return yield* upError("T3 Connect is unavailable in this build.");
  }
  const current: Routes = {
    tailscale: before.settings.tailscale,
    connect: before.connect === true,
    lan: before.settings.lan,
  };
  const asks = [flags.tailscale, flags.connect, flags.lan].every(Option.isNone);
  const tailscale =
    asks || Option.getOrElse(flags.tailscale, () => current.tailscale)
      ? yield* checkTailscale()
      : ({ ok: false, reason: "Tailscale was not checked." } as const);
  const plan = planRoutes(
    {
      installed: before.service.installed,
      current,
      available: { tailscale: tailscale.ok, connect: before.connect !== null },
    },
    flags,
  );
  const interactive = !flags.yes && interactiveTerminal();
  let routes = plan.routes;
  if (plan.ask.length > 0 && interactive) {
    if (before.service.installed) yield* Console.log(`Current setup\n${formatSetup(before)}\n`);
    if (!tailscale.ok) yield* Console.log(`Tailscale is not offered. ${tailscale.reason}\n`);
    const picked = yield* Prompt.run(
      Prompt.MultiSelect({
        message: "How can your other devices reach this machine?",
        choices: plan.ask.map((route) => ({
          ...CHOICES[route],
          value: route,
          selected: plan.routes[route],
        })),
      }),
    ).pipe(Effect.catchTags({ QuitError: () => Effect.succeed(null) }));
    if (picked === null) return yield* Console.log("Nothing changed.");
    routes = {
      tailscale: picked.includes("tailscale"),
      connect: picked.includes("connect"),
      lan: picked.includes("lan"),
    };
  } else if (plan.ask.length > 0 && !flags.yes && !before.service.installed) {
    const offered = [
      ...(tailscale.ok ? ["t3 up --tailscale"] : []),
      ...(before.connect === null ? [] : ["t3 up --connect"]),
      "t3 up --lan",
    ];
    return yield* upError(
      `Choose how your other devices reach this machine: ${offered.join(", ")}, or more than one. --yes takes the default.`,
    );
  }
  // Nothing to run in the background, but a route left on still gets turned off.
  if (!before.service.installed && !routes.connect && !routes.lan && !routes.tailscale) {
    if (current.connect || before.connectRevoked) {
      yield* disconnectCloud({ clearAuthorization: false });
    }
    yield* CliService.writeServiceEnv(config.baseDir, {
      ...(current.lan ? { T3CODE_LAN: "false" } : {}),
      ...(current.tailscale ? { T3CODE_TAILSCALE_SIGN_IN: undefined } : {}),
    });
    return yield* Console.log(formatNextSteps(routes));
  }
  if (routes.tailscale && !tailscale.ok) {
    return yield* upError(`${tailscale.reason} Then run t3 up again.`);
  }

  const requireGrant = flags.requireGrant || before.requireGrant;
  const signIn =
    routes.tailscale && tailscale.ok
      ? yield* tailscaleEntries(tailscale, flags, requireGrant)
      : null;
  const writes: Readonly<Record<string, string | undefined>> = {
    T3CODE_LAN: String(routes.lan),
    ...(signIn?.entries ?? (current.tailscale ? { T3CODE_TAILSCALE_SIGN_IN: undefined } : {})),
  };
  const planned = Object.fromEntries(
    Object.entries({ ...before.entries, ...writes }).flatMap(([key, value]) =>
      value === undefined ? [] : [[key, value] as const],
    ),
  );
  const { installedVersion } = before.service;
  const newer =
    installedVersion !== undefined &&
    compareExactServiceVersions(installedVersion, packageJson.version) > 0;
  // A running service reads these settings only at start. Asked before anything
  // changes, so a declined restart leaves service.env matching what it runs.
  // A stopped service of this version is not current, so reconcile starts it;
  // a newer one is left alone and needs this restart to start.
  const stopped = before.service.problems?.includes("service-stopped") === true;
  const restart =
    before.service.installed &&
    (before.service.current || newer) &&
    (!sameSettings(before.settings, serviceSettings(planned, true)) ||
      (routes.connect && !current.connect) ||
      stopped);
  if (restart && interactive && !stopped) {
    const confirmed = yield* Prompt.run(
      Prompt.Confirm({
        message: "Restart T3 Code to apply this? Running agent turns stop.",
        initial: true,
      }),
    ).pipe(Effect.catchTags({ QuitError: () => Effect.succeed(false) }));
    if (!confirmed) return yield* Console.log("Nothing changed.");
  }

  // Once on, it stays on: rerunning without the flag must never widen access.
  if (routes.tailscale && flags.requireGrant) {
    yield* turnOnRequireGrant(config.stateDir, "turned on with t3 up --require-grant");
  }
  if (routes.connect && !current.connect) {
    yield* Console.log("T3 Connect");
    const linked = yield* linkEnvironmentForConnect({
      headless: flags.headless,
      installRelayClient: true,
    });
    if (linked === null) return;
    yield* Console.log(`✓ Signed in${linked.identity ? ` as ${linked.identity}` : ""}\n`);
  }
  if (!routes.connect && (current.connect || before.connectRevoked)) {
    yield* disconnectCloud({ clearAuthorization: false });
  }
  // Settings land before the service starts, so it never runs with sign-in half set up.
  yield* CliService.writeServiceEnv(config.baseDir, writes);
  if (before.host !== undefined) {
    yield* Console.warn(
      `service.env sets T3CODE_HOST=${before.host}, which decides where T3 Code listens. Remove it to use these choices.`,
    );
  }

  const printServeCommand = Effect.fn(function* (reason: string) {
    const { command } = yield* resolveHostCliCommand("serve", [
      ...Option.match(flags.baseDir, { onNone: () => [], onSome: (dir) => ["--base-dir", dir] }),
      ...(routes.lan ? ["--lan"] : []),
      ...(routes.tailscale ? ["--tailscale-sign-in"] : []),
    ]);
    yield* Console.log(`${reason} Run this and keep the terminal open:\n  ${command}\n`);
  });
  let started = false;
  if (!before.service.supported) {
    yield* printServeCommand("This machine cannot run T3 Code in the background.");
  } else {
    if (newer) {
      yield* Console.log(
        `A newer t3@${installedVersion} background service is installed, so it keeps that version.`,
      );
    }
    const result = newer
      ? ({ changed: false } as const)
      : yield* CliService.reconcileService().pipe(
          Effect.catchTags({
            BootServicePrerequisiteError: (error) => Effect.succeed({ failed: error.message }),
            BootServiceUnsupportedError: (error) => Effect.succeed({ failed: error.message }),
          }),
        );
    if ("failed" in result) {
      // An installed service may still run with the old values, so keep the file matching it.
      if (before.service.installed) {
        yield* CliService.writeServiceEnv(
          config.baseDir,
          Object.fromEntries(Object.keys(writes).map((key) => [key, before.entries[key]])),
        );
      }
      yield* printServeCommand(`Background setup did not finish: ${result.failed}`);
    } else if (result.changed) {
      yield* Console.log(CliService.formatServiceChange(result));
      started = true;
    } else if (restart) {
      const outcome = yield* service.restart;
      yield* Console.log(
        outcome === "queued"
          ? "Restart queued. This session runs inside the service and disconnects when it goes down."
          : "Restarted the T3 Code service.",
      );
      started = outcome === "restarted";
    }
  }
  if (started && routes.connect && !current.connect) yield* waitForReachability();

  yield* Console.log(`\nThis machine\n${formatSetup(yield* readSetup())}\n`);
  if (signIn !== null && tailscale.ok) {
    yield* Console.log(formatTailscale(tailscale, signIn.owner, signIn.port, requireGrant));
  }
  yield* Console.log(formatNextSteps(routes));
});

const routeFlag = (name: Route, description: string) =>
  Flag.Boolean(name).pipe(Flag.withDescription(description), Flag.optional);

export const upCommand = Command.make("up", {
  ...projectLocationFlags,
  tailscale: routeFlag(
    "tailscale",
    `Let your tailnet devices sign in with no code: devices your tailnet policy grants ${TAILNET_APP_CAPABILITY}, else your own untagged devices. --no-tailscale turns it off.`,
  ),
  connect: routeFlag(
    "connect",
    "Reach this machine through T3 Connect, signed in with your T3 account. --no-connect turns it off.",
  ),
  lan: routeFlag(
    "lan",
    "Let devices on your local network and tailnet connect directly with a pairing code. --no-lan turns it off.",
  ),
  owner: Flag.String("owner").pipe(
    Flag.withDescription(
      "Tailscale login that owns this host when it is tagged, for scripts. Stored as the user ID. Implies --tailscale.",
    ),
    Flag.optional,
  ),
  requireGrant: Flag.Boolean("require-grant").pipe(
    Flag.withDescription(
      `Let in only devices your tailnet policy grants ${TAILNET_APP_CAPABILITY}, with no fallback to your own devices. Stays on for later runs. Implies --tailscale.`,
    ),
    Flag.withDefault(false),
  ),
  tailscaleServe: Flag.Boolean("tailscale-serve").pipe(
    Flag.withDescription(
      "Also serve this machine over HTTPS with Tailscale Serve. --no-tailscale-serve turns it off. Implies --tailscale.",
    ),
    Flag.optional,
  ),
  yes: Flag.Boolean("yes").pipe(
    Flag.withDescription(
      "Ask nothing. A new machine gets Tailscale when it runs here, else T3 Connect; otherwise keep what is set.",
    ),
    Flag.withDefault(false),
  ),
  headless: headlessFlag,
}).pipe(
  Command.withDescription(
    "Set up this machine so your other devices can use it, through Tailscale, T3 Connect, or your local network. Runs T3 Code in the background.",
  ),
  Command.withHandler((flags) =>
    runCloudCommand(
      flags,
      setUp({
        ...flags,
        // The Tailscale settings only mean something with Tailscale on.
        tailscale:
          Option.isNone(flags.tailscale) &&
          (Option.isSome(flags.owner) || flags.requireGrant || Option.isSome(flags.tailscaleServe))
            ? Option.some(true)
            : flags.tailscale,
      }),
      { quietLogs: true },
    ),
  ),
);

export const connectCommand = Command.make("connect", {
  ...projectLocationFlags,
  headless: headlessFlag,
}).pipe(
  Command.withDescription("Set up T3 Connect for this machine. Same as `t3 up --connect`."),
  Command.withHandler((flags) =>
    runCloudCommand(
      flags,
      setUp({
        ...flags,
        connect: Option.some(true),
        tailscale: Option.none(),
        lan: Option.none(),
        yes: false,
        owner: Option.none(),
        requireGrant: false,
        tailscaleServe: Option.none(),
      }),
      { quietLogs: true },
    ),
  ),
  Command.withSubcommands(connectSubcommands),
);

export const statusCommand = Command.make("status", projectLocationFlags).pipe(
  Command.withDescription("Show how your other devices can reach this machine."),
  Command.withHandler(
    Effect.fn("cli.status")(function* (flags) {
      const config = yield* resolveCliAuthConfig(flags, yield* GlobalFlag.LogLevel);
      // Only what readSetup reads: no database, unlike the T3 Connect commands.
      const setup = yield* readSetup().pipe(
        Effect.provide(
          Layer.merge(CliService.layer(config), ServerSecretStore.layer).pipe(
            Layer.provideMerge(ServerConfig.layer(config)),
          ),
        ),
      );
      yield* Console.log(
        `This machine\n${formatSetup(setup)}\n\nChange this with \`t3 up\`. For who can sign in through Tailscale, run \`t3 tailscale status\`.`,
      );
    }),
  ),
);
