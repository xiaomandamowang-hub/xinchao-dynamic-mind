# Guimai controlled state publication v1

This opt-in Linux-only profile lets a separate Guimai service read Xinchao's
primary state through a dedicated Unix reader group without changing the
privacy of any other store.

The default remains:

```env
STATE_PUBLICATION_PROFILE=private
STATE_READER_GID=
```

`private` keeps the existing StateStore behavior: temporary and final files use
`0600`, the parent may be created normally, and no reader group is accepted.

The future controlled profile is:

```env
STATE_PATH=/absolute/dedicated/hearthline-state/state.json
STATE_PUBLICATION_PROFILE=controlled-reader-v1
STATE_READER_GID=<dedicated-reader-group-numeric-gid>
```

It fails closed unless:

- `STATE_PATH` is absolute, ends in `state.json`, and has a parent distinct from
  the transition journal, OAuth state, and Bridge queue parents;
- the parent already exists, is not a symlink, is owned by the Xinchao process,
  has the configured group, and has exact mode `02750`;
- the platform supplies POSIX uid/gid and permission semantics.

The application never creates the controlled directory. A controlled write
opens the temporary file at `0600`, writes and syncs all bytes, applies `0640`
with `FileHandle.chmod()`, syncs metadata, verifies owner/group/mode, closes the
inode, and only then atomically renames it to `state.json`. The setgid directory
supplies group inheritance. Reads reject a linked file or a published file whose
owner, group, or mode drifts.

Only the primary StateStore receives this profile. Bridge Queue keeps the
default StateStore, OAuth keeps its explicit `0600`, and the transition journal
is unchanged. The feature does not create a Guimai mount, add a systemd group,
move existing state, start a service, expose a tool, or enable production.

Deployment and migration remain separate operator steps. Rollback removes the
Guimai consumer bind/group/selection and leaves Xinchao's dedicated primary
state in place.
