/* Settings for the East End app. Nothing private belongs in this file: it is public. */
window.EE_CONFIG = {
  version: "2.0.0",

  /* The private repository that holds the board, stars, notes and reports. */
  notebook: "east-end-notebook",
  branch: "main",

  /* Leave blank on GitHub Pages: the owner is read from the address (owner.github.io). */
  owner: "",

  api: "https://api.github.com",

  /* Public half of the notification key. The private half lives in the notebook, never here. */
  vapidPublicKey: "BFpYPScTh5dcNWyw7bGs0eBxeuTQqNfnYo-c4shppiJw66gy3FrKs-QEtyIPwM7upSpaadsoPJbx_AQcsEMWduc"
};
