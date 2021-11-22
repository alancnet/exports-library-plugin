# Webpack ExportsLibraryPlugin

I threw this together because Node 14+ supports ESM style imports against CommonJS modules,
but only if exports are directly assigned to `exports`, but not if `exports` is reassigned.

Webpack reassigns `exports` for some reason, so resulting libraries don't work this way.

This plugin will add code to export the library in a node-friendly way.

## Usage

```
npm install --save-dev exports-library-plugin
```

In `webpack.config.js`, either in `entry[name]` or in `output`:

```javascript
library: {
  name: 'exports',
  type: 'assign-properties'
}
```

Then

```javascript
const ExportsLibraryPlugin = require('exports-library-plugin')

module.exports = {
  plugins: [
    new ExportsLibraryPlugin()
  ]
}
```

This will preserve the ability to import from the resulting library.

Cheers!!

PS: If someone from Webpack would like to do this properly, I would greatly appreciate it!
