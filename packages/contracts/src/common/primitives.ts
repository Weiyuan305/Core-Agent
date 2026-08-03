import Type, { type Static } from "typebox";

export const SchemaVersionSchema = Type.Literal(1, {
  title: "SchemaVersion",
});

export const OpaqueIdSchema = Type.String({ minLength: 1, maxLength: 255 });
export const UtcTimestampSchema = Type.String({
  format: "date-time",
  pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,9})?Z$",
});
export const ResourceVersionSchema = Type.Integer({ minimum: 1 });
export const SequenceSchema = Type.Integer({ minimum: 0 });

export const ResourceMetadataFields = {
  schema_version: SchemaVersionSchema,
  resource_version: ResourceVersionSchema,
  created_at: UtcTimestampSchema,
  updated_at: UtcTimestampSchema,
} as const;

export const ResourceMetadataSchema = Type.Object(ResourceMetadataFields, {
  additionalProperties: false,
  $id: "core-agent://v1/resource-metadata",
});

export const TraceContextSchema = Type.Object(
  {
    request_id: OpaqueIdSchema,
    trace_id: OpaqueIdSchema,
    client_request_id: OpaqueIdSchema,
  },
  { additionalProperties: false, $id: "core-agent://v1/trace-context" },
);

export const PageRequestSchema = Type.Object(
  {
    schema_version: SchemaVersionSchema,
    cursor: Type.Optional(OpaqueIdSchema),
    limit: Type.Integer({ minimum: 1, maximum: 200 }),
  },
  { additionalProperties: false, $id: "core-agent://v1/page-request" },
);

export const PageInfoSchema = Type.Object(
  {
    schema_version: SchemaVersionSchema,
    next_cursor: Type.Optional(OpaqueIdSchema),
    has_more: Type.Boolean(),
  },
  { additionalProperties: false, $id: "core-agent://v1/page-info" },
);

export type ResourceMetadata = Static<typeof ResourceMetadataSchema>;
export type TraceContext = Static<typeof TraceContextSchema>;
export type PageRequest = Static<typeof PageRequestSchema>;
export type PageInfo = Static<typeof PageInfoSchema>;
