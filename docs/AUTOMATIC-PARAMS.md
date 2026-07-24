# Automatic parameter panel

Ingenue publishes an authoritative catalog of the active script's supported norns parameters and renders it at:

```text
http://norns.local:7777/params.html
```

The catalog preserves visible groups and separators and supports number, option, control, taper, trigger and binary parameters. File and text parameters are intentionally omitted because they require dedicated file/text workflows rather than generic continuous controls.

Catalog generations are assembled atomically from localhost OSC start/item/option/end messages. The browser never renders a partial generation. Continuous controls use one Lua-applied command in flight and retain only the latest desired value.

Trigger parameters use an explicit `param.trigger` command. Other writable parameters use normalized values, with option labels and formatted values supplied by norns rather than guessed in the browser.
