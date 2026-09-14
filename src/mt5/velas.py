"""
LAS VELAS DEL BROKER, para analizar con los mismos precios con los que se opera.

    python src/mt5/velas.py --salida=RUTA.json [--pares=USDJPY,GBPJPY] [--tf=5m,15m] [--n=3000]

POR QUE EXISTE
--------------
Hasta el 13 sep el analisis salia de Yahoo y las ordenes iban a XM. Midiendo la diferencia sobre
~2.940 velas de 5m por par aparecio un sesgo CONSTANTE, con Yahoo siempre por encima:

    USDJPY  +0,82p      EURJPY  +0,91p
    GBPJPY  +0,93p      AUDJPY  +1,35p

Las velas estaban bien alineadas —comparar T contra T daba 0,84-1,43 pips y contra T±5min daba
2,87-4,68— y media y mediana casi coincidian, que es la firma de un desfase sistematico y no de
ruido. Sobre los stops de 7-9 pips de `afinado` eso es el 9-19% del riesgo; sobre los 1,8 pips
de `video`, mas de la mitad.

Decidir en un libro y ejecutar en otro no se arregla con un ajuste: se arregla leyendo del mismo
sitio. Eso es esto.

LA HORA VA EN UTC, Y ESO NO ES UN DETALLE
-----------------------------------------
MT5 devuelve `time` como un epoch construido con la hora del SERVIDOR, no con UTC. XM va en
UTC+3 en verano. El mismo fallo aparecio el 13 sep en el medidor de spread: el informe por horas
salia desplazado tres horas, justo encima de la franja que decide. Aqui seria peor todavia,
porque las velas desplazadas casarian mal con cualquier otra fuente.

El desfase se deduce comparando la ultima vela con el reloj real, no se supone.

SOLO LEE. Este fichero no manda ordenes.
"""
import argparse
import json
import os
import time
from datetime import datetime, timezone

try:
    import MetaTrader5 as mt5
except ImportError:  # pragma: no cover - solo en maquinas sin terminal
    mt5 = None

PARES = ["USDJPY", "GBPJPY", "EURJPY", "AUDJPY"]

# Las que usa la estrategia. El nombre de la izquierda es el que entiende el resto del proyecto.
TF = {
    "5m": ("TIMEFRAME_M5", 300),
    "15m": ("TIMEFRAME_M15", 900),
    "1h": ("TIMEFRAME_H1", 3600),
    "1d": ("TIMEFRAME_D1", 86400),
}


def desfase_servidor(pares):
    """
    Segundos que el reloj del servidor va por delante de UTC, deducidos de la vela mas reciente.

    Se redondea a la media hora porque hay husos a :30 y porque la ultima vela puede llevar unos
    segundos abierta. Suponer +3 a pelo funcionaria hoy y fallaria al cambiar el horario.
    """
    mejor = None
    for p in pares:
        r = mt5.copy_rates_from_pos(p, mt5.TIMEFRAME_M5, 0, 1)
        if r is not None and len(r):
            t = int(r[0]["time"])
            if mejor is None or t > mejor:
                mejor = t
    if mejor is None:
        return 0
    return int(round((mejor - time.time()) / 1800.0) * 1800)


def sacar(par, tf, n, desfase):
    """Las ultimas `n` velas de un par, en el formato que entiende el resto del proyecto."""
    constante, paso = TF[tf]
    r = mt5.copy_rates_from_pos(par, getattr(mt5, constante), 0, n)
    if r is None or len(r) == 0:
        return []
    out = []
    for v in r:
        o, h, l, c = float(v["open"]), float(v["high"]), float(v["low"]), float(v["close"])
        # LA MISMA CRIBA QUE HACE `datos.ts` CON YAHOO. Una vela con el cierre fuera del rango o
        # un minimo en cero es imposible, y envenena cualquier cosa que use stops.
        if min(o, h, l, c) <= 0:
            continue
        if c > h + 1e-9 or c < l - 1e-9 or o > h + 1e-9 or o < l - 1e-9:
            continue
        out.append({
            "t": int(v["time"]) - desfase,
            "o": o, "h": h, "l": l, "c": c,
            "v": int(v["tick_volume"]),
        })
    return out


def main():
    if mt5 is None:
        raise SystemExit("Falta el paquete MetaTrader5. Esto solo corre donde esta el terminal.")
    ap = argparse.ArgumentParser()
    ap.add_argument("--salida", required=True)
    ap.add_argument("--pares", default=",".join(PARES))
    ap.add_argument("--tf", default="5m,15m")
    ap.add_argument("--n", type=int, default=6000,
                    help="velas de la temporalidad mas corta; las demas se escalan")
    args = ap.parse_args()

    pares = [x.strip() for x in args.pares.split(",") if x.strip()]
    tfs = [x.strip() for x in args.tf.split(",") if x.strip()]
    # LAS DOS TEMPORALIDADES TIENEN QUE CUBRIR EL MISMO PERIODO.
    #
    # Con `n` igual para todas, 3.000 velas son 10 dias en 5m y 31 en 15m. Entonces una
    # divergencia de hace tres semanas se emparejaba con el principio del 5m y buscaba su
    # entrada ahi, en precio que no tiene nada que ver con ella. Medido el 14 sep, eso inventaba
    # operaciones con un 91% de acierto: no era una estrategia buena, era la misma operacion
    # contada cincuenta veces.
    #
    # `--n` se aplica a la temporalidad mas CORTA y el resto se escala para durar lo mismo.
    paso_corto = min(TF[t][1] for t in tfs)
    cuantas = {t: max(300, int(args.n * paso_corto / TF[t][1])) for t in tfs}
    for t in tfs:
        if t not in TF:
            raise SystemExit(f"temporalidad desconocida: {t}. Hay {', '.join(TF)}")

    if not mt5.initialize():
        raise SystemExit(f"no se pudo conectar con el terminal: {mt5.last_error()}")
    for p in pares:
        mt5.symbol_select(p, True)
    desfase = desfase_servidor(pares)

    datos = {}
    faltan = []
    for t in tfs:
        for p in pares:
            vs = sacar(p, t, cuantas[t], desfase)
            if len(vs) < 300:
                faltan.append(f"{p} {t} ({len(vs)})")
                continue
            # La clave lleva el sufijo de Yahoo para que el resto del proyecto no note el cambio
            # de fuente: los registros, los pares y los informes hablan ese vocabulario.
            datos.setdefault(t, {})[f"{p}=X"] = vs
    cuenta = mt5.account_info()
    servidor = cuenta.server if cuenta is not None else "?"
    mt5.shutdown()

    if faltan:
        print(f"FALTAN {len(faltan)}: {', '.join(faltan)}")
    if not datos:
        raise SystemExit("no se saco ninguna vela. No se escribe nada.")

    salida = {
        "fuente": f"MT5 {servidor}",
        "desfase": desfase,
        "sacadas": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "tf": datos,
    }
    # Se escribe al lado y se renombra encima: el grabador puede estar leyendo este fichero.
    os.makedirs(os.path.dirname(os.path.abspath(args.salida)) or ".", exist_ok=True)
    tmp = args.salida + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(salida, f)
    os.replace(tmp, args.salida)

    for t, d in datos.items():
        primera = min(min(v["t"] for v in vs) for vs in d.values())
        ultima = max(max(v["t"] for v in vs) for vs in d.values())
        edad = (time.time() - ultima) / 60
        print(f"{t}: {len(d)} pares · {sum(len(v) for v in d.values())} velas · "
              f"cubre {(ultima - primera) / 86400:.1f} dias · ultima hace {edad:.0f} min")
    print(f"servidor {desfase / 3600:+.1f}h sobre UTC · guardado en {args.salida}")


if __name__ == "__main__":
    main()
