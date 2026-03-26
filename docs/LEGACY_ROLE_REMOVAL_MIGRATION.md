# Legacy Role Removal Migration Guide

## Goal

Safely remove legacy roles from your system without breaking authentication, authorization, or UI visibility.

This guide is written for a custom role and role-assignment setup where:
- users have one or more role assignments
- roles carry permission lists
- backend checks permissions for route access
- frontend shows/hides modules based on permissions

## Why direct deletion is risky

If you delete legacy roles first, users can immediately lose effective permissions, which causes:
- unexpected `403 Forbidden` errors on APIs
- missing sidebar/menu items
- broken workflows for non-admin users
- support spikes and hard-to-debug access incidents

## Migration strategy (zero-downtime style)

### Phase 1: Discover and map

1. Create an inventory of legacy roles:
   - role id
   - role name
   - permission list
   - number of assigned users
2. Define a target role mapping:
   - `legacy_role -> new_role` (or many-to-one)
3. Identify edge cases:
   - users with only legacy roles
   - users with mixed legacy and current roles
   - legacy roles with custom one-off permissions

## Phase 2: Prepare compatibility

Before touching user assignments, ensure runtime compatibility exists:
- permission checks should work for both old and new permission sources
- any hardcoded role-name checks should include new role names
- admin/agent/system-role checks should not depend on soon-to-be-deleted role names only

Keep this compatibility layer temporary and measurable.

## Phase 3: Backfill user assignments

1. For each user with legacy roles:
   - assign mapped target roles
2. Keep legacy roles assigned for now (dual assignment window)
3. Record migration audit fields:
   - migratedAt
   - migratedBy
   - previousRoleIds
   - newRoleIds

## Phase 4: Validate before cutover

Run verification checks:
- count users still only on legacy roles (must be zero before deletion)
- compare effective permission sets pre/post migration for sampled users
- smoke-test critical flows by role:
  - login
  - dashboard navigation
  - high-priority APIs
  - approval/update actions

Recommended checks:
- API 403/401 error rate
- frontend permission-based visibility
- role-based queue/action pages

## Phase 5: Remove legacy assignments

After validation:
1. remove legacy roles from user assignments
2. keep role definitions in database for a short observation window (24-72h)
3. monitor production logs and support tickets

If stable, proceed to final deletion.

## Phase 6: Delete legacy role definitions

Delete legacy role records only when:
- no users reference those role IDs
- no code path depends on legacy role names
- no seeds/startup scripts recreate legacy roles unintentionally

Also update:
- role seed scripts
- role-management UI options
- onboarding defaults

## Rollback plan (must exist before migration)

Prepare rollback artifacts:
- export of `users -> roleIds` before migration
- export of role documents (legacy and new)
- reversible migration script

Rollback steps:
1. reassign previous roleIds from backup
2. restore any removed legacy role documents
3. re-run permission smoke checks

## Operational checklist

- [ ] Legacy role inventory completed
- [ ] Mapping approved by product/security
- [ ] Compatibility layer deployed
- [ ] User assignments backfilled
- [ ] Validation checks passed
- [ ] Legacy assignments removed
- [ ] Observation window clean
- [ ] Legacy roles deleted
- [ ] Seeds/docs updated

## Common pitfalls

- Deleting role docs before assignment migration
- Forgetting special-case role checks (`isAdmin`, `isAgent`, etc.)
- Migrating roles but not updating permission aliases
- Ignoring background jobs/cron workers that use role logic
- Skipping rollback backups

## Suggested communication plan

- Announce migration window internally
- Inform QA/support about expected behavior
- Share a short validation matrix by role type
- Post-migration summary with metrics and final state

