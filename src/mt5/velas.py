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

from cuenta import exigir_cuenta
from terminal import conectar
from simbolos import operables_de, simbolo_broker
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
        r = mt5.copy_rates_from_pos(p, mt5.TIMEFRAME_M5, 0, 1)  # ya son nombres del broker
        if r is not None and len(r):
            t = int(r[0]["time"])
            if mejor is None or t > mejor:
                mejor = t
    if mejor is None:
        return 0
    desfase = int(round((mejor - time.time()) / 1800.0) * 1800)
    # UN DESFASE IMPOSIBLE NO ES UN DESFASE: es que las velas venian rancias.
    #
    # Esto se deduce de la vela mas nueva, y da la respuesta correcta SOLO si esa vela es de
    # ahora. El 15 sep el terminal acababa de cambiar de cuenta y devolvio historial viejo: la
    # vela mas nueva era de 17,5 h antes, asi que aqui salio un desfase de -17,5 h.
    #
    # Y entonces todo el fichero quedo fechado 20 horas EN EL FUTURO. Peor todavia: la guarda de
    # velas rancias resta este mismo desfase para calcular la antiguedad, asi que le salio
    # NEGATIVA y dio las velas por frescas. Seis registros apuntaron una señal inventada.
    #
    # Ningun broker del mundo esta a mas de 14 horas de UTC. Fuera de ese margen no se adivina:
    # se para, porque un fichero con fechas falsas contamina los registros en silencio.
    if not (-12 * 3600 <= desfase <= 14 * 3600):
        raise SystemExit(
            f"el desfase deducido son {desfase / 3600:+.1f} h, que no existe en ningun broker.\n"
            "Suele significar que el terminal devolvio velas viejas (recien cambiado de cuenta,\n"
            "o aun descargando historial). No se escribe nada: un fichero mal fechado envenena\n"
            "los registros sin que nada falle."
        )
    return desfase


def sacar(simbolo, tf, n, desfase):
    """Las ultimas `n` velas de un simbolo, en el formato que entiende el resto del proyecto."""
    constante, paso = TF[tf]
    r = mt5.copy_rates_from_pos(simbolo, getattr(mt5, constante), 0, n)
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
    ap.add_argument("--cuenta", type=int, default=0,
                    help="login que DEBE tener el terminal; si no, no se escribe nada")
    ap.add_argument("--terminal", default="",
                    help="ruta a terminal64.exe; con varios instalados, cual usar")
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

    mal = conectar(mt5, args.terminal)
    if mal:
        raise SystemExit(mal)

    # ANTES DE LEER UNA SOLA VELA. El terminal se engancha a la cuenta que haya puesta, y
    # cada cuenta trae su grupo de simbolos con su spread. Sacar las velas de la cuenta
    # equivocada mete en el registro precios de otro instrumento sin que nada falle.
    mal = exigir_cuenta(mt5.account_info(), args.cuenta)
    if mal:
        mt5.shutdown()
        raise SystemExit(mal)

    # COMO SE LLAMA CADA PAR AQUI, preguntado al terminal en vez de supuesto.
    #
    # El 14 sep el terminal cambio de cuenta demo y en la nueva los cruces solo existen con
    # sufijo: `GBPJPY` no existe, `GBPJPY#` si. Pidiendo el nombre pelado, MT5 contesta
    # "Terminal: Call failed" y `copy_rates_from_pos` devuelve None; el fichero salia con 7
    # pares de 12 y los grabadores seguian corriendo con lo que hubiera.
    # Y DE LOS QUE HAY, LOS QUE SE PUEDEN OPERAR. En esta cuenta conviven `EURUSD` (grupo
    # Standard, DESACTIVADO, 2,20 pips) y `EURUSD#` (Ultra Low, operable, 1,30). Sacar las velas
    # del primero seria medir sobre un instrumento que no se puede tocar y que ademas cuesta el
    # doble: decidir en un libro y ejecutar en otro, otra vez.
    todos = mt5.symbols_get() or []
    vivos = {s.name for s in todos}
    operables = operables_de(todos)
    nombres = {}
    sin_simbolo = []
    for p in pares:
        real = simbolo_broker(p, vivos, operables)
        if real is None:
            sin_simbolo.append(p)
            continue
        nombres[p] = real
        mt5.symbol_select(real, True)
    if sin_simbolo:
        print(f"NO EXISTEN EN ESTA CUENTA: {', '.join(sin_simbolo)}")
    renombrados = [f"{p}->{r}" for p, r in nombres.items() if p != r]
    if renombrados:
        # Que un par se pida con un nombre y se lea con otro tiene que VERSE. Si algun dia el
        # resolutor acierta con el simbolo equivocado, esta linea es lo unico que lo delata.
        print(f"SIMBOLOS RENOMBRADOS: {', '.join(sorted(renombrados))}")
    desfase = desfase_servidor(list(nombres.values()))

    datos = {}
    faltan = []
    for t in tfs:
        for p, real in nombres.items():
            vs = sacar(real, t, cuantas[t], desfase)
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
        # DE QUE SIMBOLO SALIO CADA PAR, y no es un adorno.
        #
        # En esta cuenta conviven `EURUSD` (Standard, 2,20 pips) y `EURUSD#` (Ultra Low, 1,30).
        # Las velas son BID, asi que el mismo mercado da DOS series distintas segun el grupo: con
        # medio pip de diferencia constante, que sobre un stop de 18 pips es el 3% del riesgo.
        #
        # Escribirlo aqui permite que el grabador lo meta en sus ajustes y se NIEGUE a continuar
        # un registro empezado con el otro grupo. Es la misma guarda que ya impidio mezclar Yahoo
        # con XM; sin ella, un cambio de cuenta mezcla dos series sin que nada avise.
        "simbolos": nombres,
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
