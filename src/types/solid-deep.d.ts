/**
 * Типы для deep-импортов клиентской сборки solid.
 *
 * В bun bare "solid-js" резолвится в dist/server.js (SSR-сборка — эффекты
 * одноразовые), поэтому рантайм-код, которому нужна реактивность одного
 * экземпляра с @opentui/solid, импортирует клиентскую dist/solid.js
 * напрямую. У deep-путей нет .d.ts — типизируем их здесь содержимым пакета.
 */
// Внутри ambient-модулей relative-импорты не обрабатываются — реэкспорт
// только по имени пакета (bare-спецификатор резолвится в types пакета).
declare module "solid-js/dist/solid.js" {
  export * from "solid-js"
}

declare module "solid-js/store/dist/store.js" {
  export * from "solid-js/store"
}
