import { describe, expect, it } from "vitest";
import { repos } from "@repo/db";
import { parseInput, UpdateServiceBody } from "@repo/contracts";
import { normalizeComposeServices } from "@repo/sdk";
import { DockerRuntime } from "../../../../../packages/adapters/src/runtime/docker";
import { parseComposeFile } from "@repo/platform/engine/lib/compose-parser";
import { projectServicesToDeployableServices } from "@repo/platform/engine/modules/deployments/compose/project-services";
import { seedOrg, seedProject } from "../../helpers/seed";

const YAML = `services:
  app:
    image: alpine:3.21
    read_only: true
    tmpfs: ["/tmp:size=16m,mode=1777"]
    cap_drop: [ALL]
    security_opt: ["no-new-privileges:true"]
`;

describe("Compose restrictions survive delivery", () => {
  it("carries import, API edits, storage and frozen deploy state to Docker", async () => {
    const parsed = parseComposeFile(YAML);
    expect(parsed.unsupported).toEqual([]);
    const { advanced } = parseInput(UpdateServiceBody, { advanced: parsed.services[0]!.advanced });
    const { organizationId } = await seedOrg();
    const project = await seedProject(organizationId, { framework: "docker-compose" });
    const [stored] = await repos.service.syncFromCompose(project.id, [
      { ...parsed.services[0]!, advanced },
    ]);
    const [release] = projectServicesToDeployableServices([stored!]);
    // A frozen release serializes exactly the same shape used during a rollback.
    const frozen = JSON.parse(JSON.stringify(release));
    let created: Record<string, any> | undefined;
    const runtime = await DockerRuntime.create({
      dockerSocketPath: "/nonexistent/openship-test.sock",
    });
    (runtime as unknown as { _docker: unknown })._docker = {
      getContainer: () => ({ remove: async () => undefined }),
      getImage: () => ({ inspect: async () => ({ RepoDigests: [] }) }),
      createContainer: async (args: Record<string, any>) => {
        created = args;
        return {
          id: "test-container",
          start: async () => undefined,
          inspect: async () => ({ NetworkSettings: { Networks: {} }, Config: {} }),
        };
      },
    };
    await runtime.deployServiceWorkload(
      { id: "test-network" },
      {
        ...frozen,
        deploymentId: "test-release",
        projectId: project.id,
        slug: "test",
        serviceName: "app",
        namespaceVolumes: true,
      },
    );
    expect(created?.HostConfig).toMatchObject({
      ReadonlyRootfs: true,
      Tmpfs: { "/tmp": "size=16m,mode=1777" },
      CapDrop: ["ALL"],
      SecurityOpt: ["no-new-privileges:true"],
    });
    // Deleting these declarations from the source must remove them, while a
    // partial API edit (or snapshot lacking advanced) must preserve them.
    await repos.service.syncFromCompose(project.id, [{ name: "app", image: "alpine:3.21" }]);
    expect((await repos.service.findById(stored!.id))?.advanced?.readOnly).toBe(true);
    await repos.service.syncFromCompose(project.id, [{ name: "app", image: "alpine:3.21" }], {
      composeAuthoritative: true,
    });
    expect((await repos.service.findById(stored!.id))?.advanced?.readOnly).toBeUndefined();
    expect((await repos.service.findById(stored!.id))?.advanced?.tmpfs).toBeUndefined();
  });

  it("keeps YAML import and normalized CLI sync consistent", () => {
    const fromCli = normalizeComposeServices(
      {
        services: {
          app: {
            image: "alpine:3.21",
            read_only: true,
            tmpfs: ["/tmp:size=16m,mode=1777"],
            cap_drop: ["ALL"],
            security_opt: ["no-new-privileges:true"],
          },
        },
      },
      "/project",
    );
    expect(fromCli[0]?.advanced).toEqual(parseComposeFile(YAML).services[0]?.advanced);
  });

  it.each([
    "read_only: invalid",
    "cap_drop: ALL",
    "tmpfs: [relative/path]",
    'tmpfs: ["/tmp", "/tmp"]',
    'security_opt: ["unsupported-option"]',
  ])("blocks restrictions that cannot be honored: %s", (field) => {
    const parsed = parseComposeFile(`services:\n  app:\n    image: alpine\n    ${field}\n`);
    expect(parsed.unsupported.some((issue) => issue.blocking)).toBe(true);
  });
});
