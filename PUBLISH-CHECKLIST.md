# Publishing Checklist

## Quick Publish Steps (Patch Release)

```bash
# 1. Unlink (if linked)
cd d:/projects/algoclan/fitverse/fitverse-be
npm unlink @classytic/revenue @classytic/revenue-manual

cd d:/projects/packages/revenue/revenue && npm unlink -g
cd d:/projects/packages/revenue/revenue-manual && npm unlink -g

# 2. Bump version
cd d:/projects/packages/revenue
npm run version:patch

# 3. Test pack
npm run test:pack

# 4. Test in real project
cd d:/projects/algoclan/fitverse/fitverse-be
npm install ../packages/revenue/classytic-revenue-0.0.X.tgz
npm install ../packages/revenue/classytic-revenue-manual-0.0.X.tgz
# Test your app here!

# 5. Clean up
npm uninstall @classytic/revenue @classytic/revenue-manual
cd d:/projects/packages/revenue && rm *.tgz

# 6. Git commit
git add .
git commit -m "chore: release v0.0.X"
git tag v0.0.X
git push origin main --tags

# 7. Publish
npm run publish:all

# 8. Re-link for dev (optional)
cd revenue && npm link
cd ../revenue-manual && npm link
cd d:/projects/algoclan/fitverse/fitverse-be
npm link @classytic/revenue @classytic/revenue-manual
```

---

## Available Scripts

| Script | What it does |
|--------|--------------|
| `npm run version:patch` | Bump both packages: 0.0.1 → 0.0.2 |
| `npm run version:minor` | Bump both packages: 0.0.1 → 0.1.0 |
| `npm run version:major` | Bump both packages: 0.0.1 → 1.0.0 |
| `npm run version:patch:revenue` | Bump only revenue package |
| `npm run version:patch:manual` | Bump only manual package |
| `npm run test:pack` | Create .tgz files for testing |
| `npm run publish:all` | Publish both packages to npm |
| `npm run publish:revenue` | Publish only revenue |
| `npm run publish:revenue-manual` | Publish only manual |

---

## Pre-Publish Checklist

- [ ] All packages unlinked
- [ ] Version bumped
- [ ] Tested with `npm pack`
- [ ] TypeScript types work
- [ ] Git committed and tagged
- [ ] Ready to publish

---

## First-time npm Publish Setup

If publishing for the first time:

```bash
# Login to npm
npm login

# Verify you're logged in
npm whoami

# Publish (make sure packages are public)
npm run publish:all
```

---

## Troubleshooting

**Error: "You do not have permission to publish"**
- Make sure you're logged in: `npm whoami`
- Verify package name is available on npm
- Check `package.json` has `"access": "public"` for scoped packages

**Error: "This package already exists"**
- You forgot to bump the version
- Run `npm run version:patch` again

**Types not working after publish**
- Check `.d.ts` files are in `files` array in package.json
- Check `exports` has `types` field
- Test with `npm pack` before publishing

**Error: "ERESOLVE could not resolve" peer dependency conflict**
- This happens when version bump conflicts with peer dependencies
- **Solution**: Use flexible peer dependency ranges in `revenue-manual/package.json`:
  ```json
  "peerDependencies": {
    "@classytic/revenue": ">=0.0.1 <1.0.0"
  }
  ```
- This allows any 0.x version without manual updates
