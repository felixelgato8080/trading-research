"""Que hay al otro lado: cuenta, simbolos y spread ahora mismo. No manda ordenes."""
import sys
import MetaTrader5 as mt5

PARES = ["EURUSD", "GBPUSD", "USDJPY", "USDCHF", "AUDUSD", "USDCAD", "NZDUSD",
         "EURJPY", "EURGBP", "GBPJPY", "AUDJPY", "CADJPY"]

if not mt5.initialize():
    print("no se pudo conectar con el terminal:", mt5.last_error())
    sys.exit(1)

cuenta = mt5.account_info()
if cuenta is None:
    print("conectado al terminal pero sin cuenta:", mt5.last_error())
    mt5.shutdown()
    sys.exit(1)

print(f"broker      {cuenta.company}")
print(f"servidor    {cuenta.server}")
print(f"tipo        {'DEMO' if cuenta.trade_mode == 0 else 'REAL  <-- OJO'}")
print(f"divisa      {cuenta.currency}   saldo {cuenta.balance:,.2f}")
print(f"apalancam.  1:{cuenta.leverage}")
print()

todos = {s.name for s in mt5.symbols_get()}
print(f"{'par':<10}{'bid':>11}{'ask':>11}{'spread':>10}{'en pips':>10}{'digitos':>9}")
print("-" * 61)
for p in PARES:
    nombre = p if p in todos else next((s for s in todos if s.startswith(p)), None)
    if nombre is None:
        print(f"{p:<10}{'no existe en este broker':>50}")
        continue
    mt5.symbol_select(nombre, True)
    t = mt5.symbol_info_tick(nombre)
    info = mt5.symbol_info(nombre)
    if t is None or info is None or t.bid == 0:
        print(f"{p:<10}{'sin cotizacion (mercado cerrado?)':>50}")
        continue
    spread = t.ask - t.bid
    pip = 0.01 if "JPY" in nombre else 0.0001
    print(f"{nombre:<10}{t.bid:>11.5f}{t.ask:>11.5f}{spread:>10.5f}"
          f"{spread / pip:>10.2f}{info.digits:>9}")

mt5.shutdown()
