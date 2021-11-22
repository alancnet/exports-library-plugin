const { ConcatSource } = require("webpack-sources");
const { UsageState } = require("webpack/lib/ExportsInfo");
const Template = require("webpack/lib/Template");
const propertyAccess = require("webpack/lib/util/propertyAccess");
const { getEntryRuntime } = require("webpack/lib/util/runtime");
const AbstractLibraryPlugin = require('webpack/lib/library/AbstractLibraryPlugin')
const RuntimeGlobals = require("webpack/lib/RuntimeGlobals");
const JavascriptModulesPlugin = require("webpack/lib/javascript/JavascriptModulesPlugin");

/** @typedef {import("webpack-sources").Source} Source */
/** @typedef {import("webpack/declarations/WebpackOptions").LibraryOptions} LibraryOptions */
/** @typedef {import("webpack/declarations/WebpackOptions").LibraryType} LibraryType */
/** @typedef {import("webpack/lib/Chunk")} Chunk */
/** @typedef {import("webpack/lib/Compilation").ChunkHashContext} ChunkHashContext */
/** @typedef {import("webpack/lib/Compiler")} Compiler */
/** @typedef {import("webpack/lib/Module")} Module */
/** @typedef {import("webpack/lib/javascript/JavascriptModulesPlugin").RenderContext} RenderContext */
/** @typedef {import("webpack/lib/javascript/JavascriptModulesPlugin").StartupRenderContext} StartupRenderContext */
/** @typedef {import("webpack/lib/util/Hash")} Hash */
/** @template T @typedef {import("webpack/lib/library/AbstractLibraryPlugin").LibraryContext<T>} LibraryContext<T> */

const KEYWORD_REGEX =
	/^(await|break|case|catch|class|const|continue|debugger|default|delete|do|else|enum|export|extends|false|finally|for|function|if|implements|import|in|instanceof|interface|let|new|null|package|private|protected|public|return|super|switch|static|this|throw|try|true|typeof|var|void|while|with|yield)$/;
const IDENTIFIER_REGEX =
	/^[\p{L}\p{Nl}$_][\p{L}\p{Nl}$\p{Mn}\p{Mc}\p{Nd}\p{Pc}]*$/iu;

/**
 * Validates the library name by checking for keywords and valid characters
 * @param {string} name name to be validated
 * @returns {boolean} true, when valid
 */
const isNameValid = name => {
	return !KEYWORD_REGEX.test(name) && IDENTIFIER_REGEX.test(name);
};

/**
 * @param {string[]} accessor variable plus properties
 * @param {number} existingLength items of accessor that are existing already
 * @param {boolean=} initLast if the last property should also be initialized to an object
 * @returns {string} code to access the accessor while initializing
 */
const accessWithInit = (accessor, existingLength, initLast = false) => {
	// This generates for [a, b, c, d]:
	// (((a = typeof a === "undefined" ? {} : a).b = a.b || {}).c = a.b.c || {}).d
	const base = accessor[0];
	if (accessor.length === 1 && !initLast) return base;
	let current =
		existingLength > 0
			? base
			: `(${base} = typeof ${base} === "undefined" ? {} : ${base})`;

	// i is the current position in accessor that has been printed
	let i = 1;

	// all properties printed so far (excluding base)
	let propsSoFar;

	// if there is existingLength, print all properties until this position as property access
	if (existingLength > i) {
		propsSoFar = accessor.slice(1, existingLength);
		i = existingLength;
		current += propertyAccess(propsSoFar);
	} else {
		propsSoFar = [];
	}

	// all remaining properties (except the last one when initLast is not set)
	// should be printed as initializer
	const initUntil = initLast ? accessor.length : accessor.length - 1;
	for (; i < initUntil; i++) {
		const prop = accessor[i];
		propsSoFar.push(prop);
		current = `(${current}${propertyAccess([prop])} = ${base}${propertyAccess(
			propsSoFar
		)} || {})`;
	}

	// print the last property as property access if not yet printed
	if (i < accessor.length)
		current = `${current}${propertyAccess([accessor[accessor.length - 1]])}`;

	return current;
};

/**
 * @typedef {Object} ExportsLibraryPluginOptions
 * @property {LibraryType} type
 * @property {string[] | "global"} prefix name prefix
 * @property {string | false} declare declare name as variable
 * @property {"error"|"copy"|"assign"} unnamed behavior for unnamed library name
 * @property {"copy"|"assign"=} named behavior for named library name
 */

/**
 * @typedef {Object} ExportsLibraryPluginParsed
 * @property {string | string[]} name
 * @property {string | string[] | undefined} export
 */

/**
 * @typedef {ExportsLibraryPluginParsed} T
 * @extends {AbstractLibraryPlugin<ExportsLibraryPluginParsed>}
 */
class ExportsLibraryPlugin extends AbstractLibraryPlugin {
	/**
	 * @param {ExportsLibraryPluginOptions} options the plugin options
	 */
	constructor(options) {
		super({
			pluginName: "ExportsLibraryPlugin",
			type: "exports"
		});
		this.prefix = ['exports'];
		this.declare = false;
		this.unnamed = 'copy';
		this.named = "assign";
	}

  apply(compiler) {
    super.apply(compiler)

    const ExportPropertyTemplatePlugin = require("webpack/lib/library/ExportPropertyLibraryPlugin");
    new ExportPropertyTemplatePlugin({
      type: 'exports',
      nsObjectUsed: true
    }).apply(compiler);

  }

  _parseOptionsCached() {
    return {
      name: ['exports'],
      export: true
    }
  }

	/**
	 * @param {LibraryOptions} library normalized library option
	 * @returns {T | false} preprocess as needed by overriding
	 */
	parseOptions(library) {
		const { name } = library;
		if (this.unnamed === "error") {
			if (typeof name !== "string" && !Array.isArray(name)) {
				throw new Error(
					`Library name must be a string or string array. ${AbstractLibraryPlugin.COMMON_LIBRARY_NAME_MESSAGE}`
				);
			}
		} else {
			if (name && typeof name !== "string" && !Array.isArray(name)) {
				throw new Error(
					`Library name must be a string, string array or unset. ${AbstractLibraryPlugin.COMMON_LIBRARY_NAME_MESSAGE}`
				);
			}
		}
		return {
			name: /** @type {string|string[]=} */ (name),
			export: library.export
		};
	}

	/**
	 * @param {Module} module the exporting entry module
	 * @param {string} entryName the name of the entrypoint
	 * @param {LibraryContext<T>} libraryContext context
	 * @returns {void}
	 */
	finishEntryModule(
		module,
		entryName,
		{ options, compilation, compilation: { moduleGraph } }
	) {
		const runtime = getEntryRuntime(compilation, entryName);
		if (options.export) {
			const exportsInfo = moduleGraph.getExportInfo(
				module,
				Array.isArray(options.export) ? options.export[0] : options.export
			);
			exportsInfo.setUsed(UsageState.Used, runtime);
			exportsInfo.canMangleUse = false;
		} else {
			const exportsInfo = moduleGraph.getExportsInfo(module);
			exportsInfo.setUsedInUnknownWay(runtime);
		}
		moduleGraph.addExtraReason(module, "used as library export");
	}

	_getPrefix(compilation) {
		return this.prefix === "global"
			? [compilation.outputOptions.globalObject]
			: this.prefix;
	}

	_getResolvedFullName(options, chunk, compilation) {
		const prefix = this._getPrefix(compilation);
		const fullName = options.name ? prefix.concat(options.name) : prefix;
		return fullName.map(n =>
			compilation.getPath(n, {
				chunk
			})
		);
	}

	/**
	 * @param {Source} source source
	 * @param {RenderContext} renderContext render context
	 * @param {LibraryContext<T>} libraryContext context
	 * @returns {Source} source with library export
	 */
	render(source, { chunk }, { options, compilation }) {
		const fullNameResolved = this._getResolvedFullName(
			options,
			chunk,
			compilation
		);
		if (this.declare) {
			const base = fullNameResolved[0];
			if (!isNameValid(base)) {
				throw new Error(
					`Library name base (${base}) must be a valid identifier when using a var declaring library type. Either use a valid identifier (e. g. ${Template.toIdentifier(
						base
					)}) or use a different library type (e. g. 'type: "global"', which assign a property on the global scope instead of declaring a variable). ${
						AbstractLibraryPlugin.COMMON_LIBRARY_NAME_MESSAGE
					}`
				);
			}
			source = new ConcatSource(`${this.declare} ${base};\n`, source);
		}
		return source;
	}

	/**
	 * @param {Module} module the exporting entry module
	 * @param {RenderContext} renderContext render context
	 * @param {LibraryContext<T>} libraryContext context
	 * @returns {string | undefined} bailout reason
	 */
	embedInRuntimeBailout(module, { chunk }, { options, compilation }) {
		const topLevelDeclarations =
			module.buildInfo && module.buildInfo.topLevelDeclarations;
		if (!topLevelDeclarations)
			return "it doesn't tell about top level declarations.";
		const fullNameResolved = this._getResolvedFullName(
			options,
			chunk,
			compilation
		);
		const base = fullNameResolved[0];
		if (topLevelDeclarations.has(base))
			return `it declares '${base}' on top-level, which conflicts with the current library output.`;
	}

	/**
	 * @param {RenderContext} renderContext render context
	 * @param {LibraryContext<T>} libraryContext context
	 * @returns {string | undefined} bailout reason
	 */
	strictRuntimeBailout({ chunk }, { options, compilation }) {
		if (
			this.declare ||
			this.prefix === "global" ||
			this.prefix.length > 0 ||
			!options.name
		) {
			return;
		}
		return "a global variable is assign and maybe created";
	}

	/**
	 * @param {Source} source source
	 * @param {Module} module module
	 * @param {StartupRenderContext} renderContext render context
	 * @param {LibraryContext<T>} libraryContext context
	 * @returns {Source} source with library export
	 */
	renderStartup(source, module, { chunk }, { options, compilation }) {
		const fullNameResolved = this._getResolvedFullName(
			options,
			chunk,
			compilation
		);
		const exportAccess = options.export
			? propertyAccess(
					Array.isArray(options.export) ? options.export : [options.export]
			  )
			: "";
		const result = new ConcatSource(source);
    //const topLevelDeclarations = Array.from(compilation.modules).find(x => x.constructor.name === 'NormalModule').buildInfo.topLevelDeclarations
    const topModule = Array.from(compilation.modules).find(x => x.index === 0)
    const topLevelDeclarations = topModule.buildInfo.topLevelDeclarations
		result.add(`if (typeof exports !== 'undefined') {\n`)
    for (const name of topLevelDeclarations) {
      result.add(
        `  exports.${name}=__webpack_exports__.${name}\n`
      )
    }
		result.add(`}\n`)
		return result;
	}

	/**
	 * @param {Chunk} chunk the chunk
	 * @param {Set<string>} set runtime requirements
	 * @param {LibraryContext<T>} libraryContext context
	 * @returns {void}
	 */
	runtimeRequirements(chunk, set, libraryContext) {
		// we don't need to return exports from runtime
	}

	/**
	 * @param {Chunk} chunk the chunk
	 * @param {Hash} hash hash
	 * @param {ChunkHashContext} chunkHashContext chunk hash context
	 * @param {LibraryContext<T>} libraryContext context
	 * @returns {void}
	 */
	chunkHash(chunk, hash, chunkHashContext, { options, compilation }) {
		hash.update("ExportsLibraryPlugin");
		const prefix =
			this.prefix === "global"
				? [compilation.outputOptions.globalObject]
				: this.prefix;
		const fullName = options.name ? prefix.concat(options.name) : prefix;
		const fullNameResolved = fullName.map(n =>
			compilation.getPath(n, {
				chunk
			})
		);
		if (options.name ? this.named === "copy" : this.unnamed === "copy") {
			hash.update("copy");
		}
		if (this.declare) {
			hash.update(this.declare);
		}
		hash.update(fullNameResolved.join("."));
		if (options.export) {
			hash.update(`${options.export}`);
		}
	}
}

module.exports = ExportsLibraryPlugin;
