# @classytic/revenue

> Revenue management monorepo - Core + Providers

Organized like Vercel AI SDK: Core package + separate provider packages.

---

## 📦 Package Structure

```
packages/
├── revenue/              # @classytic/revenue (core)
│   ├── core/
│   ├── providers/
│   ├── services/
│   ├── enums/
│   ├── schemas/
│   ├── utils/
│   ├── index.js
│   ├── package.json
│   └── README.md
│
├── revenue-manual/       # @classytic/revenue-manual (provider)
│   ├── index.js
│   ├── package.json
│   └── README.md
│
└── package.json          # Workspace root
```


---

## 📥 How to Install (After Publishing)

### Install Core + Manual Provider

```bash
npm install @classytic/revenue @classytic/revenue-manual
```

### Usage

```javascript
import { createRevenue } from '@classytic/revenue';
import { ManualProvider } from '@classytic/revenue-manual';

const revenue = createRevenue({
  models: { Transaction },
  providers: {
    manual: new ManualProvider(),
  },
});

await revenue.monetization.create({ monetizationType: 'purchase', ... });
```

### Install with Stripe Provider (Future)

```bash
npm install @classytic/revenue @classytic/revenue-stripe
```

```javascript
import { createRevenue } from '@classytic/revenue';
import { StripeProvider } from '@classytic/revenue-stripe';

const revenue = createRevenue({
  models: { Transaction },
  providers: {
    stripe: new StripeProvider({ apiKey: process.env.STRIPE_KEY }),
  },
});
```

---

## 🔧 Development Workflow

### Add New Provider

1. Create new folder: `packages/revenue-{provider}/`
2. Copy structure from `revenue-manual/`
3. Implement provider methods
4. Add to workspace: `workspaces: ["revenue", "revenue-manual", "revenue-stripe"]`
5. Publish: `npm publish --workspace=@classytic/revenue-stripe --access public`

---

## 📝 Publishing

**To publish packages:**
```bash
# Install dependencies
npm install

# Publish both packages
npm run publish:all

# Or publish individually
npm run publish:revenue
npm run publish:revenue-manual
```

**After publishing, install in your project:**
```bash
npm install @classytic/revenue @classytic/revenue-manual
```

---

## 🎯 Publishing Checklist

Before publishing:

- [ ] Update version numbers in package.json files
- [ ] Test packages work independently
- [ ] Create GitHub repository
- [ ] Add LICENSE file
- [ ] Update README with usage examples
- [ ] Run `npm login`
- [ ] Run `npm run publish:all`
- [ ] Test installation: `npm install @classytic/revenue`

---

## 📚 Package Versions

- `@classytic/revenue` - v0.1.0 (NEW: Escrow, hold/release, multi-party splits, affiliate support)
- `@classytic/revenue-manual` - v0.0.1

---

## 📖 Documentation

- **[Complete Documentation](./docs/README.md)** - Comprehensive guides and examples
- **[Building Payment Providers](./docs/guides/PROVIDER_GUIDE.md)** - Create custom payment integrations
- **[Core Package](./revenue/README.md)** - @classytic/revenue API reference
- **[Manual Provider](./revenue-manual/README.md)** - Manual payment verification

## 🔗 Links

- **GitHub**: https://github.com/classytic/revenue
- **npm**: https://npmjs.com/package/@classytic/revenue (after publishing)
- **Issues**: https://github.com/classytic/revenue/issues

---

**Built with ❤️ by Classytic**
