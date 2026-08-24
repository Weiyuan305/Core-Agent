-- A Profile may legitimately return to an earlier effective Capability set
-- after an add-on or seat is removed.  Reuse the current identical Snapshot,
-- but allow a later monotonic Snapshot version for a recurring historical set.
alter table entitlement_snapshots
  drop constraint entitlement_snapshots_input_key;

create index entitlement_snapshots_input_lookup_idx
  on entitlement_snapshots (tenant_id, profile_id, canonical_input_hash, snapshot_version desc);
