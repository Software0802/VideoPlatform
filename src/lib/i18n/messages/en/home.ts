import type { home as zh } from "../zh-CN/home";

/** English strings for `home`; the type forces every zh-CN key to exist here. */
export const home: Record<keyof typeof zh, string> = {
  "home.banner": "Featured banner",
  "home.tabs.aria": "Creation categories",
  "home.tab.video": "Video",
  "home.tab.image": "Image",
  "home.tab.template": "Templates",
  "home.tab.challenge": "Challenges",
  "home.cat.all": "All",

  "home.empty.noWorks": "Nothing here yet — write a prompt below to get started.",
  "home.empty.noVideo": "No video creations yet.",
  "home.empty.noImage": "No image creations yet.",
  "home.empty.noneInCat": "Nothing in this category yet — try another one.",
  "home.more": "Load more",
  "home.loadFailed": "Could not load. Please try again later.",

  "home.sampleMeta": "Sample",
  "home.noPrompt": "(No prompt — the first frame sets the scene)",
  "home.purged.badge": "Cleared after expiry",
  "home.purged.title": "{prompt} (cleared after expiry)",
  "home.purged.note":
    "This creation has passed its retention window; the render and its assets were deleted. You can generate it again from this prompt.",

  "home.dialog.aria": "Creation details",
  "home.tags.label": "Tags",
  "home.tags.custom": "Custom tag",
  "home.tags.max": "Up to {n} tags",
  "home.tags.tooLong": "A tag can be at most {n} characters",

  "home.share.copiedPrefix": "Link copied:",
  "home.share.manualPrefix": "Copy it manually:",
  "home.share.toastCopied": "Link copied — valid for {span}",
  "home.share.toastManual": "Link created — valid for {span}; please copy it manually",
  "home.share.hours": "{n} hours",

  "home.delete.confirmAria": "Confirm deletion",
  "home.delete.confirmText": "Deleting is permanent — the render and its assets go with it.",
  "home.delete.deleting": "Deleting…",
  "home.delete.confirm": "Delete for good",
  "home.delete.title": "Delete this creation",
  "home.delete.running": "The job is still running — cancel it before deleting",
  "home.reuse": "Generate again from this prompt",

  "home.tpl.loading": "Loading templates…",
  "home.tpl.empty": "No templates available yet.",

  "home.sample.2e9cde0e2fb0803e": "Deep in a cornfield, a figure in a silver hazmat suit walks toward us",
  "home.sample.a72d8b509c55bcd0": "Pixel-art canyon sunrise, a river winding through the valley",
  "home.sample.a1f3319d0d783e66": "The Bund on a rainy night, a woman in a dark teal trench coat walks to the river",
  "home.sample.f3bfe52263d0656d": "Morning mist in the valley, the camera pushing in slowly",
  "home.sample.d99c0972e1f99b67": "Neon street, slow dolly",
  "home.sample.a9008119d34b8fc1": "Aerial shot along the coastline, just before sunset",
  "home.sample.5a09f4952b5ad9b6": "A single shaft of light in an old warehouse",
  "home.sample.6f297b60448c30c9": "A hutong entrance after snowfall",
  "home.sample.0450bc8d80da9173": "A claymation planet, slowly rotating",
  "home.sample.5edd8af76572172a": "Light shattering on water",
  "home.sample.8c0d9035649bec1f": "Low-poly archipelago",
  "home.sample.fd7b4eb5c10483f5": "Childhood toys, scaled up enormous",
};
