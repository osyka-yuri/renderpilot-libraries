# RenderPilot Libraries

This repository hosts graphics DLL binaries via GitHub Releases.

## Structure

ZIP files are published as GitHub Release assets, not stored in git.

## Manifest

- `manifest.json` — Library metadata (served via GitHub Pages)
- `scripts/` — Generation and publishing scripts

## Libraries

| Library | DLL File | Prefix |
|---------|----------|--------|
| DLSS | `nvngx_dlss.dll` | `nvngx_dlss_*` |
| DLSS Frame Generation | `nvngx_dlssg.dll` | `nvngx_dlssg_*` |
| DLSS Ray Reconstruction | `nvngx_dlssd.dll` | `nvngx_dlssd_*` |
| FSR 3.1 DX12 | `amd_fidelityfx_dx12.dll` | `amd_fidelityfx_dx12_*` |
| FSR 3.1 Vulkan | `amd_fidelityfx_vk.dll` | `amd_fidelityfx_vk_*` |
| XeSS | `libxess.dll` | `libxess_*` |
| XeSS Frame Generation | `libxess_fg.dll` | `libxess_fg_*` |
| XeLL | `libxell.dll` | `libxell_*` |
| XeSS DX11 | `libxess_dx11.dll` | `libxess_dx11_*` |

## Release Naming

ZIP assets follow the pattern: `{prefix}_{version}.zip`

Examples:
- `nvngx_dlss_310.6.0.0.zip`
- `nvngx_dlss_2.2.16.0_ad5efa68.zip` (for duplicate versions with different hashes)

## Download URL Pattern

```
https://github.com/osyka-yuri/renderpilot-libraries/releases/download/v1.0.0/{filename}.zip
```
