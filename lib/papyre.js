'use strict'

const chokidar = require('chokidar')
const f = require('fpx')
const fm = require('front-matter')
const fs = require('fs')
const MemoryFS = require('memory-fs')
const Module = require('module')
const pt = require('path')
const webpack = require('webpack')
const {performance} = require('perf_hooks')
const {promisify} = require('util')

const fsReadFile = promisify(fs.readFile)
const fsWriteFile = promisify(fs.writeFile)
const glob = promisify(require('glob'))
const mkdirp = promisify(require('mkdirp'))

const webpackDefaults = {
  target: 'node',
  devtool: false,
  cache: true,
  externals: externalize,
}

const PUBLICS_DIR = '/memory-fs/'
const PUBLICS_NAME = 'papyre-bundle.js'
const PUBLICS_PATH = pt.join(PUBLICS_DIR, PUBLICS_NAME)

const webpackOverrides = {
  output: {
    path: PUBLICS_DIR,
    filename: PUBLICS_NAME,
    libraryTarget: 'commonjs2',
  },
}

exports.build = build
function build(webpackConfig, onBuilt) {
  validateConfig(webpackConfig)
  f.validate(onBuilt, f.isFunction)

  const config = reconfigure(webpackConfig)
  const {dir: dirname} = pt.parse(config.entry)
  const compiler = webpack(config)
  compiler.outputFileSystem = new MemoryFS()

  compiler.run(async function onCompiled(err, stats) {
    if (err) {
      onBuilt(err)
      return
    }
    try {
      const {time: compileTime} = stats.toJson()
      const t0 = performance.now()

      const publics = evalPublics(compiler)
      const t1 = performance.now()

      const output = await buildEntries(await readEntriesFromDir(dirname), publics)
      const t2 = performance.now()

      await onBuilt(undefined, {
        entries: output,
        timing: `Bundle: ${ms(compileTime)}, eval: ${ms(t1 - t0)}, build: ${ms(t2 - t1)}`,
      })
    }
    catch (err) {
      onBuilt(err)
    }
  })
}

exports.watch = watch
function watch(webpackConfig, onBuilt) {
  validateConfig(webpackConfig)
  f.validate(onBuilt, f.isFunction)

  const config = reconfigure(webpackConfig)
  const codeExtensions = (config.resolve && config.resolve.extensions) || ['.js']
  f.validate(codeExtensions, Array.isArray)

  const {dir: dirname} = pt.parse(config.entry)
  let publics = undefined
  let entries = {}

  const chokidarWatch = new chokidar.FSWatcher()
  chokidarWatch.add(dirname)

  const compiler = webpack(config)
  compiler.outputFileSystem = new MemoryFS()

  let finishedFirstBuild = false
  let building = false

  async function rebuildOnChange(path) {
    try {
      if (codeExtensions.includes(pt.parse(path).ext)) return

      const t0 = performance.now()
      const relPath = pt.relative(dirname, path)

      try {
        const entry = await readEntry(dirname, path)
        const i = entries.findIndex(entry => entry.path === relPath)
        entries = replaceOrAppend(entries, i, entry)
      }
      catch (err) {
        if (err.code === 'ENOENT') {
          entries = entries.filter(entry => entry.path !== relPath)
        }
        else throw err
      }

      const output = await buildEntries(entries, publics)
      const t1 = performance.now()

      await onBuilt(undefined, {
        entries: output,
        timing: `Build: ${ms(t1 - t0)}`,
      })
    }
    catch (err) {
      onBuilt(err)
    }
  }

  const webpackWatch = compiler.watch({}, async function onCompiled(err, stats) {
    if (err) {
      onBuilt(err)
      return
    }

    if (building) return
    building = true
    try {
      const {time: compileTime} = stats.toJson()
      const t0 = performance.now()

      publics = evalPublics(compiler)
      const t1 = performance.now()

      entries = await readEntriesFromDir(dirname)
      const output = await buildEntries(entries, publics)
      const t2 = performance.now()

      await onBuilt(undefined, {
        entries: output,
        timing: `Bundle: ${ms(compileTime)}, eval: ${ms(t1 - t0)}, build: ${ms(t2 - t1)}`,
      })

      if (!finishedFirstBuild) {
        finishedFirstBuild = true
        chokidarWatch.on('add', rebuildOnChange)
        chokidarWatch.on('change', rebuildOnChange)
        chokidarWatch.on('unlink', rebuildOnChange)
      }
    }
    catch (err) {
      onBuilt(err)
    }
    finally {
      building = false
    }
  })

  return {
    chokidarWatch,
    webpackWatch,
    deinit() {
      chokidarWatch.close()
      webpackWatch.close()
    },
  }
}

function reconfigure(webpackConfig) {
  return patch(webpackDefaults, webpackConfig, webpackOverrides)
}

function evalPublics(compiler) {
  const script = compiler.outputFileSystem.readFileSync(PUBLICS_PATH, 'utf8')
  const mod = new Module()
  mod.paths = ['./node_modules']
  mod._compile(script, PUBLICS_PATH)
  return mod.exports
}

async function readEntriesFromDir(dirname) {
  f.validate(dirname, f.isString)
  dirname = pt.resolve(dirname)
  const paths = await filePaths(dirname)
  return Promise.all(paths.map(path => readEntry(dirname, path)))
}

async function readEntry(dirname, path) {
  const {attributes, body} = fm(await fsReadFile(path, 'utf8'))
  return patch({path: pt.relative(dirname, path), body}, attributes)
}

async function buildEntries(entries, publics) {
  const tree = entriesToTree(entries)
  const output = []
  for (const entry of entries) {
    const renderFunction = findRenderFunction(entry, publics)
    if (renderFunction) {
      const props = {entries, tree, entry}
      try {
        const result = renderFunction(props)
        // Support async rendering but stay synchronous if possible.
        // If async rendering is useful, this needs to be made concurrent.
        const body = f.isPromise(result) ? (await result) : result
        if (!f.isString(body)) {
          throw Error(`Expected rendering function ${show(renderFunction)} ` +
                      `to return a string, got ${show(body)}`)
        }
        output.push(patch(entry, {body}))
      }
      catch (err) {
        err.message = `Failed to render entry at path ${entry.path}: ${err.message}`
        throw err
      }
    }
  }
  return output
}

function findRenderFunction(entry, publics) {
  const {fn} = Object(entry.papyre)
  const renderFunction = publics[fn]
  if (f.isFunction(renderFunction)) return renderFunction
  if (fn) {
    throw Error(`Error in entry at ${entry.path}: ` +
                `expected to find render function ${fn}, ` +
                `found ${show(renderFunction)}`)
  }
  return undefined
}

exports.writeEntries = writeEntries
async function writeEntries(dirname, entries) {
  f.validate(dirname, f.isString)
  f.validateEach(entries, isEntry)
  await Promise.all(entries.map(entry => (
    writeFile(pt.join(dirname, entry.path), entry.body)
  )))
}

async function writeFile(path, content) {
  const {dir} = pt.parse(path)
  await mkdirp(dir)
  await fsWriteFile(path, content)
}

function filePaths(dirname) {
  return glob(pt.join(dirname, '/**/*'), {nodir: true})
}

function validateConfig(config) {
  if (!f.isDict(config)) {
    throw Error(`Please pass a webpack config`)
  }
  if (!f.isString(config.entry)) {
    throw Error(`Please pass a webpack config with a single entry file.`)
  }
  if (!pt.parse(config.entry).dir) {
    throw Error(`The entry file must be located in a directory`)
  }
}

function patch() {
  return Object.assign({}, ...arguments)
}

function entriesToTree(entries) {
  const out = {}
  for (const entry of entries) {
    setIn(out, entry.path.split(pt.sep), entry)
  }
  return out
}

function setIn(ref, path, value) {
  for (const key of path.slice(0, -1)) {
    if (!f.isObject(ref[key])) ref[key] = {}
    ref = ref[key]
  }
  const last = path[path.length - 1]
  ref[last] = value
}

function show(value) {
  return f.isFunction(value) ? (value.name || value.toString()) : String(value)
}

function ms(milliseconds) {return `${milliseconds.toFixed(2)}ms`}

function externalize(pathPrefix, requiredPath, done) {
  if (/[/.]/.test(requiredPath[0])) {
    // Inline
    done(undefined, undefined)
  }
  else {
    // Externalize
    done(undefined, `commonjs ${requiredPath}`)
  }
}

function isEntry(value) {
  return f.isDict(value) && f.isString(value.path) && f.isString(value.body)
}

function replaceOrAppend(list, index, value) {
  if (index >= 0 && index <= (list.length - 1)) {
    list = list.slice()
    list[index] = value
  }
  else {
    list = f.append(list, value)
  }
  return list
}