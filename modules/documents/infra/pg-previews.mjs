// Postgres part of the documents store for DWG / DXF previews (PRD-06).
// Spread into createDocumentsStore's object, like pg-links / pg-markups.
//
// documents.preview(+_layout) is keyed by the BYTES (document_id, sha256), so
// a markups-only version shares the preview of the version it copies. The
// document's preview_status mirrors the preview of its CURRENT version's bytes.
// Derived state: no ledger entry (the ledger proves the bytes, not renderings).

export function previewQueries(pool, tx) {
  async function mirrorOn(client, documentId) {
    await client.query(
      `UPDATE documents.document d
          SET preview_status = p.status, preview_reason = p.reason
         FROM documents.document_version v
         JOIN documents.preview p ON p.document_id = v.document_id AND p.sha256 = v.sha256
        WHERE d.id = $1 AND v.document_id = d.id AND v.version_no = d.current_version`,
      [documentId],
    );
  }

  return {
    async getPreview(documentId, sha256) {
      const { rows } = await pool.query(
        'SELECT * FROM documents.preview WHERE document_id = $1 AND sha256 = $2', [documentId, sha256],
      );
      return rows[0] ?? null;
    },

    async listPreviewLayouts(documentId, sha256) {
      const { rows } = await pool.query(
        `SELECT * FROM documents.preview_layout WHERE document_id = $1 AND sha256 = $2 ORDER BY layout_index`,
        [documentId, sha256],
      );
      return rows;
    },

    /** Re-mirror the current version's preview onto the document (a replay or same-bytes re-upload). */
    async mirrorPreviewStatus(documentId) {
      await mirrorOn(pool, documentId);
    },

    /** Record one conversion and mirror it. A concurrent duplicate keeps the first row. */
    async savePreview({ documentId, sha256, status, reason, converter, layers, warnings, layouts }) {
      return tx(async (client) => {
        const { rows } = await client.query(
          `INSERT INTO documents.preview (document_id, sha256, status, reason, converter, layers, warnings)
           VALUES ($1,$2,$3,$4,$5,$6,$7)
           ON CONFLICT (document_id, sha256) DO NOTHING RETURNING *`,
          [documentId, sha256, status, reason, converter, JSON.stringify(layers ?? []), JSON.stringify(warnings ?? [])],
        );
        if (rows.length) {
          for (const l of layouts) {
            await client.query(
              `INSERT INTO documents.preview_layout
                 (document_id, sha256, layout_index, name, storage_key, size_bytes, sha256_svg, width, height)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
              [documentId, sha256, l.index, l.name, l.storageKey, l.sizeBytes, l.sha256Svg, l.width ?? null, l.height ?? null],
            );
          }
        }
        await mirrorOn(client, documentId);
        return rows[0] ?? null;
      });
    },
  };
}
