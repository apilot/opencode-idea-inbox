# Пересъёмка demo.gif — сценарий без персонализации

Принцип: записываем **только поток терминала** (asciinema), а не экран.
В кадр физически не может попасть ничего, кроме TUI: ни панелей рабочего
стола, ни hostname, ни браузера. Персонализация исключена по построению.

## 0. Подготовка нейтрального стенда (один раз)

```bash
mkdir -p ~/devel/idea-demo && cd ~/devel/idea-demo
git init -q
mkdir src
cat > src/http.ts <<'EOF'
export async function fetchJSON(url: string): Promise<unknown> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}
EOF
echo "node_modules/\n*.cast\ndemo.gif" > .gitignore
```

Проект называется `idea-demo`, в кадре будет виден только этот нейтральный
бейзнейм. Никаких личных путей, имени, хоста.

## 1. Запись

```bash
# один раз: pacman -S --needed asciinema && cargo install agg
cd ~/devel/idea-demo
asciinema rec --overwrite demo.cast -c opencode
```

Дальше внутри opencode (окно 120×30, fullscreen — шелл-промпт не виден):

| # | Действие | Что в кадре |
|---|----------|-------------|
| 1 | Промпт агенту: `add a timeout option to fetchJSON in src/http.ts` | агент начал работать |
| 2 | `leader+z` → `try caching provider responses` → Enter | `○ parked` в сайдбаре |
| 3 | `leader+z` → `check flaky auth test in CI` → Enter | второй `○ parked` |
| 4 | Подождать, агент стримит | живая сессия |
| 5 | `leader+i` → Enter на первой идее | миссия ушла агенту, `◐ running` |
| 6 | Дождаться конца маленькой правки | `● done` в сайдбаре |

Цель: **15–20 секунд**, темп спокойный, без опечаток (опечатки — пересъём).

## 2. Рендер GIF

```bash
agg --cols 110 --rows 30 --speed 1.5 \
    --font-family "JetBrainsMono Nerd Font" --font-size 14 \
    demo.cast demo.gif
gifsicle -O3 --lossy=80 -o demo.min.gif demo.gif   # если тяжёлый
```

Целевой размер **< 5 МБ** (speed 1.5 и lossy помогают). Если слишком быстро
читается — уменьшить `--speed` до 1.2.

## 3. Чек-лист перед заменой

- [ ] В кадре нет: имени/ника/хоста/личных путей/токенов/лимитов аккаунта
- [ ] Название сессии в TUI нейтральное (авто-генерится от промпта — ок)
- [ ] Статусы в сайдбаре читаются: `○ → ◐ → ●`
- [ ] GIF < 5 МБ

## 4. Замена

После твоего ОК: кладём файл в `assets/demo.gif` репы, коммит и push
(ссылки в README, awesome-opencode и черновиках не меняются — raw-URL тот же).
`demo.png` (статичный скрин сайдбара) — обновить по тому же сценарию,
стоп-кадр на шаге 3 (три идеи со статусами).
