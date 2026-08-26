import { type DependencyProbe } from '@delivery/health';

type DockerPingClient = Readonly<{
  ping(): Promise<unknown>;
}>;

export function createDockerProbe(client: DockerPingClient): DependencyProbe {
  return {
    name: 'docker',
    async check() {
      try {
        await client.ping();
        return { name: 'docker', status: 'up' };
      } catch {
        return { name: 'docker', status: 'down' };
      }
    },
  };
}
