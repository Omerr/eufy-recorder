# Maintenance and recovery

Keep source and recovery current after each completed change.

- Keep personal configuration, credentials, footage, audio, and device identifiers outside tracked files.
- Run the relevant checks and tests, then the public-source checker before every commit and push.
- Commit and push completed source changes within the user-authorized publication scope.
- Update setup and recovery instructions when dependencies, state locations, integrations, or startup behavior change.
- Check `git config --get recovery.workspace` for a local private recovery checkout.
- When configured, read its AGENTS.md and inventory before updating recovery.
- After changing code or local settings, run its Backup.ps1 -Push on Windows and verify the push completed.
- Settings saved through the control page also need a fresh snapshot. The scheduled backup handles them within its configured interval.
- Report backup failures and remaining recovery gaps to the user.
- Never print recovery keys, credentials, authorization tokens, or decrypted snapshots in tool output.
- Restore into a new directory and validate phone presence before enabling physical device actions.
