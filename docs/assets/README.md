# README visual asset

- Asset: `cover.png`
- Purpose: shared concept cover for the Chinese and English READMEs; not a product screenshot or a protocol diagram.
- Generation: built-in `image_gen` tool, followed by a targeted edit. No CLI fallback or external brand assets were used.
- Architecture diagrams remain editable Mermaid source inside each README.

## Generation prompt

```text
Use case: stylized-concept
Asset type: wide GitHub README cover for the open-source DSH TOTP access-verification plugin, shared by Chinese and English documentation.
Primary request: illustrate the idea of a small, deliberate verification step before entering a developer workspace.
Scene/backdrop: a seamless near-black graphite studio with a subtle ground plane.
Subject: three restrained objects in one coherent composition: a slim smartphone displaying six softly lit neutral dots, a sculptural rounded rectangular verification gateway, and a minimal browser-workspace panel beyond the gateway. The browser panel uses a few abstract rows and a composer, no real UI content.
Style/medium: premium editorial 3D still life, matte graphite, frosted glass, fine metal edges, physically plausible soft shadows and controlled white rim light. Quiet and practical, with generous negative space and no busy decoration.
Composition/framing: very wide horizontal banner, approximately 3:1, all objects fully visible. Keep objects primarily in the right two thirds and reserve the left third for a crisp large wordmark.
Color palette: DSH-style charcoal #151517 and #2c2c2e, cool neutral gray, off-white #f9fafb, a tiny subdued blue highlight only at the gateway.
Text (verbatim): "dsh-totp" in a clean off-white sans serif on the left. No other text.
Constraints: this is a conceptual illustration, not a real screenshot or a literal network architecture diagram. Do not depict end-to-end encryption. No real QR code, no credentials, no official Google/Microsoft/DeepSeek logos, no shield badges, no giant padlock, no green success checkmarks, no people, no watermark. Excellent readability at README width.
```

## Final correction prompt

```text
Use case: precise-object-edit.
Edit target: the supplied dsh-totp README cover.
Change ONLY the phone display: replace its row of five lit dots with exactly SIX evenly spaced softly lit dots. Count must be six, representing a six-digit TOTP. Keep the full 3:1 framing, resolution, wordmark spelling "dsh-totp", phone silhouette, gateway, browser panel, materials, lighting, palette and every other detail unchanged. No extra text or symbols.
```

