// Сборка виджета лидмагнита для сайтов: один файл `public/widget.js` — элемент `livem-chat`, React и стили внутри.
// Стили теневого корня: светлые токены дизайн-системы (`:root` → `:host`), её компоненты, вид веб-чата и раскладка виджета.
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { build, type Plugin } from "esbuild";

const require = createRequire(import.meta.url);

async function widgetStyles(): Promise<string> {
  const tokens = await readFile(require.resolve("@ykurilov/ds-tokens/tokens.css"), "utf8");
  // Только светлая тема: цвета сайт задаёт сам переменными виджета
  const light = tokens.match(/^:root \{[\s\S]*?^\}/m)?.[0];
  if (!light) throw new Error("В токенах дизайн-системы нет блока :root — формат файла поменялся");
  const components = await readFile(require.resolve("@ykurilov/ds-react/styles.css"), "utf8");
  const chat = await readFile("src/ui/web-chat/web-chat.css", "utf8");
  const widget = await readFile("src/widget/widget.css", "utf8");
  return [light.replace(/^:root/, ":host"), components.replaceAll(":root", ":host"), chat, widget].join("\n");
}

const stylesModule: Plugin = {
  name: "livem-widget-styles",
  setup(builder) {
    builder.onResolve({ filter: /^livem-widget-styles$/ }, (args) => ({ path: args.path, namespace: "livem-widget-styles" }));
    builder.onLoad({ filter: /.*/, namespace: "livem-widget-styles" }, async () => ({
      contents: `export default ${JSON.stringify(await widgetStyles())};`,
      loader: "js",
    }));
  },
};

await build({
  entryPoints: ["src/widget/index.tsx"],
  outfile: "public/widget.js",
  bundle: true,
  minify: true,
  format: "iife",
  target: ["es2020", "safari15"],
  jsx: "automatic",
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
  legalComments: "none",
  // «use client» в общих файлах веб-чата — пометка для Next, в сборке виджета не нужна
  logOverride: { "module-level-directive": "silent" },
  plugins: [stylesModule],
  logLevel: "warning",
});
console.log("Виджет собран: public/widget.js");
