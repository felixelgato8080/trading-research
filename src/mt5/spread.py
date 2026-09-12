"""
EL COSTE REAL DE FOREX, medido en el terminal en vez de supuesto.

    python src/mt5/spread.py --registro=RUTA.json [--stop=8]

POR QUE ESTO DECIDE LA ESTRATEGIA ENTERA
----------------------------------------
La divergencia de RSI en 5m tiene un borde BRUTO de +0,188R con 2,8 sigma sobre 857 operaciones.
Eso no es ruido: la señal vale. Lo que la mata es el peaje, y el peaje sale de SUPONER 0,6 pips.

    coste real 0,30 pips  ->  +0,051R   gana
    coste real 0,42       ->   0,000R
    coste real 0,60       ->  -0,086R   lo que asumimos
    coste real 0,90       ->  -0,223R

Toda la conclusion cuelga de un numero que nadie ha medido. Con cripto ya pasamos por aqui:
se suponian 10 puntos basicos y el libro de Binance dio 27.

UNA FOTO NO SIRVE, Y ESO SE APRENDIO A LA MALA
----------------------------------------------
El spread de forex cambia con la hora mas que ninguna otra cosa: en el solape Londres-Nueva York
es una decima parte del de las 23:00, y en los minutos de una noticia se abre diez veces. Lo que
importa no es el spread medio: es el que hay A LAS HORAS EN QUE LA ESTRATEGIA ENTRA.

Por eso se acumula y se reporta POR HORA. Y por eso este fichero solo AÑADE muestras: una medida
tomada es un hecho de ese instante y no se puede mejorar despues. Misma regla que los grabadores.

LOS TICKS VIEJOS SE DESCARTAN Y SE CUENTAN
------------------------------------------
Con el mercado cerrado el terminal sigue devolviendo el ultimo tick del viernes. Guardarlo como
si fuera una medida mete el spread de cierre —el peor del mundo— en la distribucion de las horas
buenas. Se descarta lo que tenga mas de `MAX_EDAD` segundos y se dice cuantos se descartaron.

ESTE FICHERO NO MANDA ORDENES. Solo lee cotizaciones. En el repositorio no hay codigo de
ejecucion, y eso es por construccion, no por una variable de entorno.
"""
import argparse
import json
import os
import time
from datetime import datetime, timezone

import MetaTrader5 as mt5

PARES = ["EURUSD", "GBPUSD", "USDJPY", "USDCHF", "AUDUSD", "USDCAD", "NZDUSD",
         "EURJPY", "EURGBP", "GBPJPY", "AUDJPY", "CADJPY"]

# Un tick mas viejo que esto es el mercado cerrado, no una cotizacion.
MAX_EDAD = 180


def pip(simbolo: str) -> float:
    return 0.01 if "JPY" in simbolo else 0.0001


def mediana(xs):
    if not xs:
        return 0.0
    o = sorted(xs)
    return o[len(o) // 2]


def percentil(xs, p):
    if not xs:
        return 0.0
    o = sorted(xs)
    return o[min(len(o) - 1, int(len(o) * p))]


def tomar_muestras():
    """Una pasada por los doce pares. Devuelve las muestras validas y cuantas se cayeron."""
    vivos = {s.name for s in mt5.symbols_get()}
    muestras = []
    viejos = 0
    ahora = time.time()
    for p in PARES:
        nombre = p if p in vivos else next((s for s in vivos if s.startswith(p)), None)
        if nombre is None:
            continue
        mt5.symbol_select(nombre, True)
        t = mt5.symbol_info_tick(nombre)
        if t is None or t.bid <= 0 or t.ask <= 0:
            continue
        if ahora - t.time > MAX_EDAD:
            viejos += 1
            continue
        muestras.append({
            "par": p,
            "t": int(t.time),
            "bid": t.bid,
            "ask": t.ask,
            "pips": (t.ask - t.bid) / pip(p),
        })
    return muestras, viejos


def informe(reg, stopRef):
    """Que fraccion del riesgo se lleva el spread, por par y por hora."""
    por_par = {}
    for m in reg["muestras"]:
        por_par.setdefault(m["par"], []).append(m)
    if not por_par:
        print("Todavia no hay ninguna muestra con el mercado abierto.")
        return

    print(f"\nEL SPREAD, EN PIPS · {len(reg['muestras'])} muestras desde {reg['inicio'][:16]}")
    print(f"{'par':<10}{'muestras':>10}{'mediana':>10}{'p90':>8}{'peor':>8}"
          f"{'% de un stop de ' + str(stopRef) + ' pips':>28}")
    print("-" * 74)
    for par in sorted(por_par, key=lambda k: mediana([x["pips"] for x in por_par[k]])):
        ps = [x["pips"] for x in por_par[par]]
        med = mediana(ps)
        print(f"{par:<10}{len(ps):>10}{med:>10.2f}{percentil(ps, 0.9):>8.2f}{max(ps):>8.2f}"
              f"{med / stopRef * 100:>27.0f}%")

    print(f"\nPOR HORA UTC (mediana en pips; la estrategia entra a todas horas)")
    print(f"{'hora':<6}", end="")
    cabecera = sorted(por_par)[:8]
    for p in cabecera:
        print(f"{p:>9}", end="")
    print()
    print("-" * (6 + 9 * len(cabecera)))
    for h in range(24):
        fila = f"{h:>2}h   "
        hay = False
        for p in cabecera:
            ps = [x["pips"] for x in por_par[p]
                  if datetime.fromtimestamp(x["t"], timezone.utc).hour == h]
            if ps:
                hay = True
                fila += f"{mediana(ps):>9.2f}"
            else:
                fila += f"{'-':>9}"
        if hay:
            print(fila)

    horas = len({datetime.fromtimestamp(m["t"], timezone.utc).strftime("%Y%m%d%H")
                 for m in reg["muestras"]})
    if horas < 48:
        print(f"\nSolo {horas} horas distintas medidas. Con menos de dos dias completos esto no")
        print("cubre ni el solape de Londres ni la sesion asiatica, que es donde estan los")
        print("extremos. El numero sirve cuando haya al menos una semana.")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--registro", required=True)
    ap.add_argument("--stop", type=float, default=8.0,
                    help="stop de referencia en pips para expresar el peaje")
    ap.add_argument("--informe", action="store_true", help="solo leer y resumir, sin medir")
    args = ap.parse_args()

    reg = {"version": 1, "inicio": "", "ultima": "", "muestras": []}
    if os.path.exists(args.registro):
        with open(args.registro, encoding="utf-8") as f:
            reg = json.load(f)

    if not args.informe:
        if not mt5.initialize():
            print("no se pudo conectar con el terminal:", mt5.last_error())
            raise SystemExit(1)
        cuenta = mt5.account_info()
        if cuenta is not None and cuenta.trade_mode != 0:
            print("ATENCION: esta cuenta NO es demo. Este programa solo lee, pero avisa igual.")
        muestras, viejos = tomar_muestras()
        mt5.shutdown()

        ahora = datetime.now(timezone.utc).isoformat(timespec="seconds")
        if not reg["inicio"]:
            reg["inicio"] = ahora
        if muestras:
            # SOLO SE AÑADE. Nunca se reescribe una muestra ya tomada.
            reg["muestras"].extend(muestras)
            reg["ultima"] = ahora
            os.makedirs(os.path.dirname(os.path.abspath(args.registro)) or ".", exist_ok=True)
            with open(args.registro, "w", encoding="utf-8") as f:
                json.dump(reg, f)
            print(f"+{len(muestras)} muestras" + (f" · {viejos} ticks viejos descartados" if viejos else ""))
        else:
            print(f"mercado cerrado: 0 muestras" + (f", {viejos} ticks viejos" if viejos else ""))

    informe(reg, args.stop)


if __name__ == "__main__":
    main()
