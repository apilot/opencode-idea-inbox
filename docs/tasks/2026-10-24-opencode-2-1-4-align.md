# 2026-10-24 — Align plugin with opencode 2.1.4 (release 0.6.1)

Status: **release**

## Request

«opencode обновился и нужно подтянуть нашу версию плагина на новую версию».
Побочный симптом: в соседнем процессе по techservice64 «статусы не меняются»
(идеи висят pending после dispatch-попыток).

## Findings (recon, 2026-10-24)

- Хост: opencode **v2.1.4** (`~/.opencode/bin/opencode`, autoupdate). Плагин в кэше хоста — 0.5.8 (SDK 2.0.20 / @opentui 0.5.12).
- SDK-дифф 2.0.20 → 2.1.4: TUI-API (slot / keymap.layer / storage.memory / dialog) **additive, без ломок**; изменения в server-типах (session/permission/agent/vcs…), `session.prompt` в `SessionDomain` сохранён.
- Лог хоста: idea-inbox грузится без ошибок (валится только сторонний `opencode-pty` на новой схеме Definition).
- techservice64: база живая — 11 идей (8 documented, **3 pending**); diag.log показывает `sb.alive`/`cmd.alive` — TUI-плагин работает, статусы в сайдбаре честно отражают БД. Dispatch-попытки в diag не видны (ротация 128KB + `.catch()` без логирования — фейл промта не оставляет следа).
- Хранилище per-worktree: `techservice64_rails8/.opencode/idea-inbox/ideas.db` пуст — сессии в разных worktree видят разные бэклоги.

## Changes (0.6.1)

- deps: `@opencode/plugin` ^2.0.20 → **^2.1.4**
- devDeps: `@opencode/theme` ^2.0.20 → **^2.1.4**, `@opentui/core|solid` ^0.5.12 → **^0.6.8** (peer-требование SDK 2.1.4)
- peerDeps: `@opentui/*` ≥ 0.6.8
- diag: логировать неудачный dispatch (`cmd.take.fail` с текстом ошибки) — по мотивам инцидента «статусы не меняются»
- version → 0.6.1, BUILD → 0.6.1

## Validation

- `tsc --noEmit` — чисто против типов 2.1.4 (проверит сигнатуру `session.prompt`)
- `bun test` — эталон 80 pass / 0 fail / 235 expect / 8 files (сайдбар-тест рендерит на @opentui 0.6.8)
- tag `v0.6.1` → CI → npm `latest`; затем `rm -rf ~/.cache/opencode/npm/opencode-idea-inbox@latest`

## Constraints

- `package-lock.json` не коммитить.
- engines остаётся `>=2.0.20` (изменения аддитивные), tested-up-to 2.1.4.
