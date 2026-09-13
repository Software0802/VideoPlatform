import type { admin as zh } from "../zh-CN/admin";

/** English strings for `admin`; the type forces every zh-CN key to exist here. */
export const admin: Record<keyof typeof zh, string> = {
  "admin.relays.title": "Relays",
  "admin.relays.hint":
    "Config source: file > LUMEN_RELAYS seed > legacy env. Only the env var name is shown; keys stay in .env.",
  "admin.relays.loading": "Loading relays…",
  "admin.relays.empty": "No relays yet.",
  "admin.relays.forbidden": "No permission",
  "admin.relays.envManaged": "Defined by env; edit .env",
  "admin.relays.managedOnly": "Only file-managed entries can change",

  "admin.relays.source.file": "file",
  "admin.relays.source.envSeed": "env seed",
  "admin.relays.source.legacy": "legacy env",

  "admin.relays.channel.video": "video",
  "admin.relays.channel.image": "image",
  "admin.relays.channel.chat": "chat",

  "admin.relays.health.ok": "ok",
  "admin.relays.health.cooldown": "cooldown",
  "admin.relays.health.halfOpen": "half-open",

  "admin.relays.key.has": "key set",
  "admin.relays.key.missing": "no key",

  "admin.relays.catalog.none": "no catalog",
  "admin.relays.catalog.snapshot": "snapshot",

  "admin.relays.enabled": "Enabled",
  "admin.relays.disabled": "Disabled",
  "admin.relays.up": "Move up",
  "admin.relays.down": "Move down",
  "admin.relays.discover": "Discover",
  "admin.relays.probe": "Probe",
  "admin.relays.delete": "Delete",

  "admin.relays.probeConfirm":
    "Probing sends a real request to {name} (one 1K image or a chat ping); the upstream may bill it. Continue?",
  "admin.relays.deleteConfirm":
    "Delete relay {name}? Historical jobs still resolve (shadow table).",
  "admin.relays.probe.result": "Probe: HTTP {status} · {ms}ms · {detail}",
  "admin.relays.discover.result": "Catalog: {n} models, +{added} added, -{removed} removed",

  "admin.relays.create": "New relay",
  "admin.relays.creating": "Creating…",
  "admin.relays.createSubmit": "Create",
  "admin.relays.form.name": "Name",
  "admin.relays.form.priority": "Priority",
  "admin.relays.form.channels": "Channels",
  "admin.relays.form.imageModel": "Image model",
  "admin.relays.form.chatModel": "Chat model",
  "admin.relays.form.catalogSource": "Catalog source",
};
