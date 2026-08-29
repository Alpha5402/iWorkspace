import { type MigrationBuilder } from 'node-pg-migrate';

export function up(pgm: MigrationBuilder): void {
  pgm.sql(`
    CREATE TABLE artifact_links (
      organization_id uuid NOT NULL,
      project_id uuid NOT NULL,
      parent_artifact_id uuid NOT NULL REFERENCES artifacts(id) ON DELETE RESTRICT,
      child_artifact_id uuid NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
      relation text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (parent_artifact_id, child_artifact_id, relation),
      CHECK (parent_artifact_id <> child_artifact_id),
      FOREIGN KEY (organization_id, project_id) REFERENCES projects(organization_id, id) ON DELETE CASCADE
    );
    GRANT SELECT, INSERT, UPDATE, DELETE ON artifact_links TO iw_api, iw_worker;
    ALTER TABLE artifact_links ENABLE ROW LEVEL SECURITY;
    CREATE POLICY tenant_isolation ON artifact_links
      USING (organization_id = current_tenant_organization_id())
      WITH CHECK (organization_id = current_tenant_organization_id());
  `);
}

export function down(): never {
  throw new Error('Artifact lineage migration is forward-only.');
}
