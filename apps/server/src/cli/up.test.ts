import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NetService from "@t3tools/shared/Net";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestConsole from "effect/testing/TestConsole";
import { Command } from "effect/cli";
import { afterEach, vi } from "vite-plus/test";

import packageJson from "../../package.json" with { type: "json" };
import * as BootService from "../cloud/bootService.ts";
import { upsertServiceEnv } from "./service.ts";
import { planRoutes, resolveOwner, upCommand, upPortCheck } from "./up.ts";

const none = Option.none<boolean>();
const off = { tailscale: false, connect: false, lan: false };
const both = { tailscale: true, connect: true };
const noFlags = { tailscale: none, connect: none, lan: none };

it.each([
  {
    label: "a new machine with Tailscale starts from it and asks",
    setup: { installed: false, current: off, available: both },
    flags: noFlags,
    expected: { routes: { ...off, tailscale: true }, ask: ["tailscale", "connect", "lan"] },
  },
  {
    label: "a new machine without Tailscale starts from T3 Connect",
    setup: { installed: false, current: off, available: { tailscale: false, connect: true } },
    flags: noFlags,
    expected: { routes: { ...off, connect: true }, ask: ["connect", "lan"] },
  },
  {
    label: "a rerun starts from the current setup and can turn a route off",
    setup: {
      installed: true,
      current: { ...off, tailscale: true, lan: true },
      available: { tailscale: false, connect: false },
    },
    flags: noFlags,
    expected: { routes: { ...off, tailscale: true, lan: true }, ask: ["tailscale", "lan"] },
  },
  {
    label: "a route flag asks nothing and keeps the routes not named, even on a new machine",
    setup: { installed: false, current: off, available: both },
    flags: { ...noFlags, lan: Option.some(true) },
    expected: { routes: { ...off, lan: true }, ask: [] },
  },
])("$label", ({ setup, flags, expected }) => {
  expect(planRoutes(setup, flags)).toEqual(expected);
});

const SERVICE = {
  supported: true,
  installed: true,
  current: true,
  unitPath: "/home/me/.config/systemd/user/t3code.service",
  logPath: "/home/me/.t3/userdata/logs/boot-service.log",
} as const;

it.layer(Layer.mergeAll(NodeServices.layer, NetService.layer))("t3 up", (it) => {
  afterEach(() => vi.restoreAllMocks());

  it.effect.each<{
    readonly label: string;
    readonly installed: boolean;
    readonly status?: Partial<BootService.BootServiceStatus>;
    readonly installFails?: boolean;
    readonly env: string;
    readonly args: ReadonlyArray<string>;
    readonly installs: number;
    readonly restarts: number;
    readonly envAfter: string;
  }>([
    {
      label: "nothing changed",
      installed: true,
      env: "T3CODE_LAN=false\n",
      args: ["--no-lan"],
      installs: 0,
      restarts: 0,
      envAfter: "T3CODE_LAN=false\n",
    },
    {
      label: "the local network opens",
      installed: true,
      env: "T3CODE_LAN=false\n",
      args: ["--lan"],
      installs: 0,
      restarts: 1,
      envAfter: "T3CODE_LAN=true\n",
    },
    {
      label: "a new service starts with its settings",
      installed: false,
      env: "",
      args: ["--lan"],
      installs: 1,
      restarts: 0,
      envAfter: "T3CODE_LAN=true\n",
    },
    {
      label: "a route turns off with no service to run",
      installed: false,
      env: "T3CODE_LAN=true\n",
      args: ["--no-lan"],
      installs: 0,
      restarts: 0,
      envAfter: "T3CODE_LAN=false\n",
    },
    {
      label: "a stopped newer service starts as it is",
      installed: true,
      status: { current: false, installedVersion: "999.0.0", problems: ["service-stopped"] },
      env: "T3CODE_LAN=false\n",
      args: ["--yes"],
      installs: 0,
      restarts: 1,
      envAfter: "T3CODE_LAN=false\n",
    },
    {
      label: "a failed update keeps service.env matching the old service",
      installed: true,
      status: { current: false },
      installFails: true,
      env: "",
      args: ["--no-lan"],
      installs: 0,
      restarts: 0,
      envAfter: "",
    },
    {
      label: "the old default is kept",
      installed: true,
      env: "",
      args: ["--yes"],
      installs: 0,
      restarts: 0,
      envAfter: "T3CODE_LAN=true\n",
    },
  ])("restarts the service only when it must: $label", (input) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-up-test-" });
      yield* fs.writeFileString(`${baseDir}/service.env`, input.env);
      let installs = 0;
      let restarts = 0;
      const status = {
        ...SERVICE,
        installed: input.installed,
        current: input.installed,
        ...input.status,
      };
      vi.spyOn(BootService, "layer").mockReturnValue(
        Layer.succeed(
          BootService.BootService,
          BootService.BootService.of({
            status: Effect.succeed(status),
            withStopped: (operation) => operation,
            restart: Effect.sync(() => {
              restarts++;
              return "restarted" as const;
            }),
            install: () =>
              input.installFails === true
                ? Effect.fail(
                    new BootService.BootServicePrerequisiteError({ problem: "linger-disabled" }),
                  )
                : Effect.sync(() => {
                    installs++;
                    return {
                      program: ["t3"],
                      baseDir,
                      unitPath: status.unitPath,
                      logPath: status.logPath,
                    };
                  }),
            uninstall: Effect.succeed(false),
          }),
        ),
      );

      yield* Command.runWith(upCommand, { version: packageJson.version })([
        "--base-dir",
        baseDir,
        ...input.args,
      ]).pipe(
        Effect.provideService(HostProcess.Environment, {}),
        Effect.provide(
          Layer.mergeAll(
            ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} })),
            Layer.fresh(TestConsole.layer),
          ),
        ),
      );
      expect({ installs, restarts }).toEqual({
        installs: input.installs,
        restarts: input.restarts,
      });
      expect(yield* fs.readFileString(`${baseDir}/service.env`)).toBe(input.envAfter);
    }),
  );
});

it("rewrites only the named service.env keys and keeps the user's lines", () => {
  const before = ["# my settings", "T3CODE_PORT=4000", "export T3CODE_LAN=0", "T3CODE_LAN=1", ""];
  expect(upsertServiceEnv(before.join("\n"), { T3CODE_LAN: "true", T3CODE_HOST: undefined })).toBe(
    ["# my settings", "T3CODE_PORT=4000", "T3CODE_LAN=true", ""].join("\n"),
  );
  expect(upsertServiceEnv("", { T3CODE_LAN: "false" })).toBe("T3CODE_LAN=false\n");
});

const RUNNING_SERVICE = { port: 3773, serviceManaged: true };
const MANUAL = { port: 3773, serviceManaged: false };

it.each([
  { configuredPort: undefined, free: true, running: null, expected: "ok" },
  { configuredPort: undefined, free: false, running: RUNNING_SERVICE, expected: "ok" },
  { configuredPort: undefined, free: false, running: null, expected: "taken" },
  { configuredPort: undefined, free: false, running: MANUAL, expected: "manual" },
  // t3 up writes T3CODE_PORT=3773, so a later run still checks the port.
  { configuredPort: "3773", free: false, running: null, expected: "taken" },
  { configuredPort: "3773", free: false, running: RUNNING_SERVICE, expected: "ok" },
  { configuredPort: "4000", free: true, running: null, expected: "custom" },
  { configuredPort: "4000", free: true, running: { ...MANUAL, port: 4000 }, expected: "manual" },
] as const)(
  "port check with T3CODE_PORT=$configuredPort, free=$free, running=$running is $expected",
  ({ configuredPort, free, running, expected }) => {
    expect(upPortCheck({ configuredPort, portFree: free, running })).toBe(expected);
  },
);

it.effect("a rerun on a tagged host keeps the owner saved before, with no prompt", () =>
  Effect.gen(function* () {
    const status = {
      version: "1.90.0",
      magicDnsName: "box.example.ts.net",
      tailnetIpv4Addresses: ["100.64.0.2"],
      httpsServeEnabled: null,
      backendState: "Running",
      selfNodeId: "n1",
      selfUserId: null,
      selfTags: ["tag:t3-box"],
      keyExpiry: null,
      keyExpired: false,
      health: [],
      magicDnsEnabled: true,
      certDomains: [],
      userspaceNetworking: false,
      peers: [],
      users: [{ userId: "123", loginName: "me@example.com" }],
    };
    // Tests run with no terminal, so asking would fail with "Pass --owner".
    expect(yield* resolveOwner(status, Option.none(), "123")).toEqual({
      userId: "123",
      login: "me@example.com",
    });
  }).pipe(Effect.provide(NodeServices.layer)),
);
