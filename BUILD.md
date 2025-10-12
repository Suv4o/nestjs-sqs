## Scripts

```bash
npm run build      # compile TypeScript to dist/
npm run lint       # run ESLint across src/**/*.ts
npm run lint:fix   # auto-fix lint issues where possible
```

The `prepublishOnly` hook makes sure the package is built before publishing.

## Publishing

```bash
npm run build
npm publish --access public
```

Only the `dist/` folder and the README are shipped (see the `files` field in `package.json`).

## Versioning

Update the `version` field in `package.json` before publishing. Semantic Versioning (`MAJOR.MINOR.PATCH`) is recommended.

## License

MIT
