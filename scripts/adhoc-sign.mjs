// electron-builder afterPack hook: ad-hoc sign the macOS app when no signing
// certificate is set up. Without any signature, Apple Silicon Macs refuse to
// open the app. It is still not notarized, so the first launch needs
// right-click > Open (or System Settings > Privacy & Security > Open Anyway).
import { execFileSync } from 'node:child_process'
import path from 'node:path'

export default async function adhocSign(context) {
  if (context.electronPlatformName !== 'darwin' || process.env.CSC_LINK || process.env.CSC_NAME) return
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' })
}
