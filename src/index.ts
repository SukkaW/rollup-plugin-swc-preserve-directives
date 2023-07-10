import type { Plugin } from 'rollup'
import { extname } from 'path'
import { parse } from '@swc/core'
import { MagicString } from '@napi-rs/magic-string'

import type { ParseOptions } from '@swc/core'

const availableESExtensionsRegex = /\.(m|c)?(j|t)sx?$/
const tsExtensionsRegex = /\.(m|c)?ts$/
const directiveRegex = /^use (\w+)$/

const isNonNull = <T>(val: T | null | undefined): val is T => val != null;

interface PreserveDirectiveMeta {
  shebang: string | null,
  directives: Record<string, Set<string>>
}

export default function swcPreserveDirectivePlugin(): Plugin {
  const meta: PreserveDirectiveMeta = {
    shebang: null,
    directives: {},
  }

  return {
    name: 'swc-render-directive',
    async transform(code, id) {
      const ext = extname(id)
      if (!availableESExtensionsRegex.test(ext)) return code

      const isTypescript = tsExtensionsRegex.test(ext)
      const parseOptions: ParseOptions = {
        syntax: isTypescript ? 'typescript' : 'ecmascript',
        [isTypescript ? 'tsx' : 'jsx']: true,
        privateMethod: true,
        classPrivateProperty: true,
        exportDefaultFrom: true,
        script: false, target: 'es2019',
      } as const

      const { body, interpreter, span: { start: offset } } = await parse(code, parseOptions)
      if (interpreter) {
        meta.shebang = `#!${interpreter}`
        code = code.replace(new RegExp('^[\\s\\n]*' + meta.shebang.replace(/\//g, '\/') + '\\n*'), '') // Remove shebang from code
      }

      let magicString: null | MagicString = null

      for (const node of body) {
        if (node.type === 'ExpressionStatement') {
          if (node.expression.type === 'StringLiteral' && directiveRegex.test(node.expression.value)) {
            meta.directives[id] ||= new Set<string>();
            meta.directives[id].add(node.expression.value);

            magicString ||= new MagicString(code)
            magicString.remove(node.span.start - offset, node.span.end - offset)
          }
        } else {
          // Only parse the top level directives, once reached to the first non statement literal node, stop parsing
          break
        }
      }

      return {
        code: magicString ? magicString.toString() : code,
        map: magicString ? magicString.generateMap({ hires: true }).toMap() : null,
      }
    },

    renderChunk(code, { moduleIds }, { sourcemap }) {
      const outputDirectives = moduleIds
        .map((id) => meta.directives[id])
        .filter(isNonNull)
        .reduce((acc, directives) => {
          directives.forEach((directive) => acc.add(directive));
          return acc;
        }, new Set<string>());

      let ms: null | MagicString = null

      if (outputDirectives.size > 0) {
        ms ||= new MagicString(code)
        ms.prepend(`${Array.from(outputDirectives).map(directive => `'${directive}';`).join('\n')}\n`)
      }
      if (meta.shebang) {
        ms ||= new MagicString(code)
        ms.prepend(`${meta.shebang}\n`)
      }

      return {
        code: ms ? ms.toString() : code,
        map: (sourcemap && ms) ? ms.generateMap({ hires: true }).toMap() : null
      }
    }
  }
}
