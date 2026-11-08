# Universal Hockey Portal – Render / Neon contingency source

Built from the working October 27 Render source. Deploy the same files to separate Friday and Sunday Render services. Restore each day’s matching portal JSON backup into its own Neon database; verify all settings after restoration.

## Targeted changes
- Available-spots count flashes after roster release only when spots remain (reduced-motion respected).
- Intelligent device-backup popup checks the persisted-state fingerprint on admin-panel opening; it does not repeatedly prompt for unchanged data. Download or Not Now acknowledges that version on that device.
- No MFA introduced. Removed the 15-minute rate limiter from **administrator** login only; other role and abuse rate limits remain. Administrator password remains the Render `ADMIN_PASSWORD`.
- Existing maintenance mode, scheduling, database, import/export and other application logic preserved. **Maintenance mode by itself may not stop scheduling**: keep each Render scheduler disabled as you have already verified.

## Deployment
1. Deploy this ZIP’s contents at the repository root, with `server.js` and `package.json` at the top level.
2. Keep the original Render environment settings and point `DATABASE_URL` to the **contingency** Neon database, not Pi production.
3. Restore the respective Friday/Sunday backup; verify game day, signup code, roster, release/reset times, maintenance mode and disabled schedulers.
4. Keep player traffic on Pi until a deliberate failover.

## Testing limitation
Syntax and archive checks are performed locally. Browser behavior, Render startup, Neon connectivity, and full restore must be verified after deployment.
