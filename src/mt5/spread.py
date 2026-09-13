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

CADA MUESTRA SABE DE QUE CUENTA VIENE
-------------------------------------
El spread no es una propiedad del par: es una propiedad del par EN ESE BROKER Y ESE TIPO DE
CUENTA. En XM, una Standard cotiza EURUSD a 1,6 pips y una Zero a 0,2 mas comision: ocho veces
mas. Mezclar muestras de dos cuentas da un numero que no es el de ninguna de las dos.

Por eso cada muestra lleva el servidor y el login, y el informe separa por servidor. Si cambias
de cuenta a mitad, se ve en vez de disolverse en la media.

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


def barrido(nombres, servidor, login, vistos):
    """Una lectura de los doce pares. `vistos` evita contar dos veces la misma cotizacion."""
    muestras = []
    viejos = 0
    faltan = []
    repetidos = 0
    ahora = time.time()
    for p in PARES:
        nombre = nombres[p]
        if nombre is None:
            faltan.append(f"{p} (no existe en este broker)")
            continue
        t = mt5.symbol_info_tick(nombre)
        if t is None or t.bid <= 0 or t.ask <= 0:
            # UN PAR QUE SE CAE EN SILENCIO ES PEOR QUE UN PAR QUE FALTA: la media se calcula
            # sobre los que quedaron y nadie se entera de que faltaban.
            faltan.append(f"{p} (sin cotizacion)")
            continue
        if ahora - t.time > MAX_EDAD:
            viejos += 1
            continue
        # LA MISMA COTIZACION LEIDA DOS VECES NO ES DOS MEDIDAS. En un par tranquilo el tick
        # puede no moverse en minutos; guardarlo cada vez que se mira cargaria la distribucion
        # hacia los momentos quietos, que son justo los que NO deciden nada.
        clave = (p, int(t.time), t.bid, t.ask)
        if clave in vistos:
            repetidos += 1
            continue
        vistos.add(clave)
        muestras.append({
            "par": p,
            "t": int(t.time),
            "bid": t.bid,
            "ask": t.ask,
            "pips": (t.ask - t.bid) / pip(p),
            "servidor": servidor,
            "login": login,
        })
    return muestras, viejos, faltan, repetidos


def tomar_muestras(servidor, login, veces, intervalo):
    """
    Varias lecturas repartidas dentro de la pasada, no una sola.

    POR QUE NO BASTA UNA FOTO CADA QUINCE MINUTOS. Lo que puede matar esta estrategia no es el
    spread medio: es el que hay en el minuto de una noticia, cuando se abre cinco o diez veces
    durante medio minuto y se vuelve a cerrar. Muestreando una vez cada quince minutos, la
    probabilidad de caer dentro de ese medio minuto es del 3%: el pico no se ve NUNCA, y el
    registro diria que todo esta bien mientras las operaciones de esos minutos se lo comen.

    Medido el 12 sep: el 39% de las operaciones de `afinado` entran entre las 21h y las 7h UTC
    y aportan el 78% del resultado, con un margen de solo ~1,3 pips sobre el coste supuesto.
    Ahi es donde hace falta resolucion.
    """
    vivos = {s.name for s in mt5.symbols_get()}
    nombres = {}
    for p in PARES:
        nombres[p] = p if p in vivos else next((s for s in vivos if s.startswith(p)), None)

    # SE SELECCIONAN TODOS ANTES DE LEER NINGUNO. `symbol_select` mete el simbolo en el Market
    # Watch, pero su primera cotizacion no esta disponible en la misma llamada: en la primera
    # pasada tras reiniciar el terminal se caian 5 de los 12. Seleccionar primero y leer despues
    # les da el tiempo que necesitan.
    for nombre in nombres.values():
        if nombre is not None:
            mt5.symbol_select(nombre, True)

    todas = []
    viejos = 0
    faltan = []
    repetidos = 0
    vistos = set()
    for k in range(veces):
        if k > 0:
            time.sleep(intervalo)
        ms, v, f, rep = barrido(nombres, servidor, login, vistos)
        todas.extend(ms)
        viejos += v
        repetidos += rep
        # Los que faltan se reportan una vez, no doce.
        if k == 0:
            faltan = f
    return todas, viejos, faltan, repetidos


def informe(reg, stopRef, tope):
    """Que fraccion del riesgo se lleva el spread, por par y por hora."""
    # DE QUE CUENTAS VIENEN ESTAS MUESTRAS. Si hay mas de una, el numero de abajo no es de
    # ninguna: hay que mirarlas por separado o quedarse con la que se vaya a usar.
    cuentas = {}
    for m in reg["muestras"]:
        k = f"{m.get('servidor', '?')} / {m.get('login', '?')}"
        cuentas[k] = cuentas.get(k, 0) + 1
    if len(cuentas) > 1:
        print("\nOJO: hay muestras de MAS DE UNA CUENTA en este registro.")
        for k, n in sorted(cuentas.items(), key=lambda x: -x[1]):
            print(f"   {k:<40}{n:>7} muestras")
        print("   El spread depende del broker y del tipo de cuenta, asi que mezclarlas da un")
        print("   numero que no es el de ninguna. Usa --cuenta=SERVIDOR para quedarte con una.")
    elif cuentas:
        k = next(iter(cuentas))
        print(f"\nCuenta medida: {k}")

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

    # ---- EL VEREDICTO -------------------------------------------------------------------
    #
    # El numero que decide no es el spread medio: es el de las horas en que la estrategia entra,
    # comparado con lo que esa franja aguanta. Medido el 12 sep sobre las 440 operaciones de
    # `afinado`, el 39% entra entre las 21h y las 7h UTC y aporta el 78% del resultado, con un
    # tope de ~2,3-2,6 pips de ida y vuelta. Dejarlo aqui escrito evita tener que acordarse.
    noche = [x["pips"] for ms in por_par.values() for x in ms
             if datetime.fromtimestamp(x["t"], timezone.utc).hour >= 21
             or datetime.fromtimestamp(x["t"], timezone.utc).hour < 7]
    dia = [x["pips"] for ms in por_par.values() for x in ms
           if 7 <= datetime.fromtimestamp(x["t"], timezone.utc).hour < 21]
    if noche and dia:
        mn, md = mediana(noche), mediana(dia)
        print(f"\nEL VEREDICTO · tope de la franja nocturna: {tope} pips de ida y vuelta")
        print(f"   noche 21-07 UTC  mediana {mn:.2f}p · p90 {percentil(noche, 0.9):.2f}p · "
              f"peor {max(noche):.2f}p   ({len(noche)} muestras)")
        print(f"   dia   07-21 UTC  mediana {md:.2f}p · p90 {percentil(dia, 0.9):.2f}p · "
              f"peor {max(dia):.2f}p   ({len(dia)} muestras)")
        if mn >= tope:
            print(f"   -> La mediana nocturna ({mn:.2f}p) YA PASA el tope ({tope}p). El 78% del")
            print("      resultado de `afinado` sale de esas horas: con este spread es negativa.")
        elif percentil(noche, 0.9) >= tope:
            print(f"   -> La mediana aguanta pero el p90 ({percentil(noche, 0.9):.2f}p) pasa el")
            print(f"      tope. Una de cada diez entradas nocturnas no paga. Mirar por hora.")
        else:
            print(f"   -> Por debajo del tope. La franja nocturna paga.")

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
    ap.add_argument("--cuenta", default="",
                    help="quedarse solo con las muestras de ese servidor")
    # OCHO LECTURAS CADA 30 SEGUNDOS = CUATRO MINUTOS de los quince que hay entre pasadas.
    # Deja once minutos de margen para que dos ejecuciones no se solapen: se solapan y las dos
    # leen el mismo fichero, lo modifican y lo escriben, y la segunda borra lo de la primera.
    ap.add_argument("--veces", type=int, default=8,
                    help="lecturas por pasada (1 = como antes, una foto)")
    ap.add_argument("--intervalo", type=float, default=30.0,
                    help="segundos entre lecturas")
    ap.add_argument("--tope", type=float, default=2.4,
                    help="spread de ida y vuelta a partir del cual la franja nocturna no paga")
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
        servidor = cuenta.server if cuenta is not None else "?"
        login = cuenta.login if cuenta is not None else 0
        veces = max(1, args.veces)
        intervalo = max(0.0, args.intervalo)
        if (veces - 1) * intervalo > 11 * 60:
            print("ATENCION: veces x intervalo pasa de 11 minutos. Con la tarea cada 15 hay")
            print("riesgo de que dos ejecuciones se solapen y una pise la escritura de la otra.")
        muestras, viejos, faltan, repetidos = tomar_muestras(servidor, login, veces, intervalo)
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
            print(f"+{len(muestras)} muestras en {veces} lecturas"
                  + (f" · {viejos} ticks viejos descartados" if viejos else "")
                  + (f" · {repetidos} cotizaciones repetidas" if repetidos else ""))
        else:
            print(f"mercado cerrado: 0 muestras" + (f", {viejos} ticks viejos" if viejos else ""))
        if faltan:
            print(f"   FALTAN {len(faltan)} de {len(PARES)}: {', '.join(faltan)}")

    if args.cuenta:
        antes = len(reg["muestras"])
        reg = dict(reg)
        reg["muestras"] = [m for m in reg["muestras"] if args.cuenta in str(m.get("servidor", ""))]
        print(f"\nFiltrado a '{args.cuenta}': {len(reg['muestras'])} de {antes} muestras.")

    informe(reg, args.stop, args.tope)


if __name__ == "__main__":
    main()
