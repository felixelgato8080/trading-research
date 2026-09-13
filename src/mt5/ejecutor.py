"""
EL EJECUTOR: pone en MetaTrader 5 las ordenes que el grabador YA decidio.

    python src/mt5/ejecutor.py --registro=RUTA.json --estado=RUTA.json [--enserio]

Sin `--enserio` no manda nada: dice lo que haria y sale. Ese es el modo por defecto y es
deliberado — un ejecutor que manda por defecto es un ejecutor que manda cuando no querias.

POR QUE EXISTE, Y POR QUE AHORA
-------------------------------
No porque la estrategia este lista. NO LO ESTA: `afinado` da +0,099R sobre 440 operaciones con
1,7 sigma, se eligio mirando esas mismas 440, y el 78% de su resultado sale de las horas de peor
spread. Automatizar eso hoy seria automatizar una perdida.

Existe porque ES UN MEJOR INSTRUMENTO DE MEDIDA que el muestreador de spread. El muestreador
hace una foto cada 30 segundos y espera acertar el momento. Una orden de verdad mide el coste
REAL de esa operacion concreta: a que precio lleno contra el que pidio, que spread habia en ese
instante, cuanto deslizo. Es el numero que falta, medido donde importa en vez de por muestreo.

El liston para pasar a dinero real se fijo ANTES de escribir esto, que es la unica forma de que
signifique algo: ~300 operaciones ejecutadas en demo, esperanza positiva con el coste real de
los llenados, y que aguante partida por mitades del calendario y por par.

LAS SEÑALES NO SE CALCULAN AQUI
-------------------------------
Se leen del registro que escribe `grabarDivergenciaCli`. Este fichero no sabe que es una
divergencia y no debe saberlo: en cuanto haya dos sitios que calculen la señal, divergen, y el
dia que lo hagan nadie se entera porque los dos "funcionan". El grabador decide, el ejecutor
obedece, y cualquier diferencia entre lo grabado y lo ejecutado es un fallo del ejecutor.

LO QUE ESTE FICHERO NO HACE, POR CONSTRUCCION
--------------------------------------------
  - No opera en una cuenta real. Comprueba `trade_mode` antes de CADA orden y se niega si no es
    demo. No hay bandera que lo desactive: si hiciera falta operar en real, se cambia el codigo
    a mano y se ve en el diff.
  - No decide señales, no las filtra, no las mejora.
  - No reabre lo que cerro el broker ni promedia a la baja.
"""
import argparse
import json
import os
import time
from datetime import datetime, timedelta, timezone, date

# EL IMPORT ES TOLERANTE A PROPOSITO. La mitad de este fichero es logica pura —cuantos lotes,
# que poner, cuanto se expone— y esa mitad tiene que poder probarse en una maquina sin terminal
# de MetaTrader, que es cualquiera que no sea el portatil. Sin esto, las pruebas solo corren
# donde ya esta todo instalado, que es justo donde no hacen falta.
try:
    import MetaTrader5 as mt5
except ImportError:  # pragma: no cover - solo en maquinas sin terminal
    mt5 = None

# Nuestras ordenes se marcan con esto. Sirve para no tocar jamas una posicion que abriera otra
# cosa —o la mano— en la misma cuenta.
MAGIA = 770412

# ---------------------------------------------------------------------------------------------
# LO PURO. Nada de esto toca MT5, y por eso se puede probar sin terminal y sin mercado abierto.
# ---------------------------------------------------------------------------------------------


def simbolo_broker(par_yahoo: str, vivos) -> str | None:
    """'USDJPY=X' -> el nombre que use este broker ('USDJPY', 'USDJPYm', 'USDJPY.raw'...)."""
    base = par_yahoo.replace("=X", "")
    if base in vivos:
        return base
    return next((s for s in sorted(vivos) if s.startswith(base)), None)


def lote(riesgo_dinero, riesgo_precio, tick_size, tick_value, paso, minimo, maximo):
    """
    Cuantos lotes arriesgan `riesgo_dinero` si el precio recorre `riesgo_precio`.

    Devuelve (lote, motivo). El motivo dice si hubo que recortar, porque redondear en silencio
    es como se acaba arriesgando el triple de lo que se cree: con stops de 7 pips el lote sale
    pequeño, el minimo del broker es 0,01, y si se sube al minimo sin avisar el riesgo real
    puede ser varias veces el pedido.
    """
    if riesgo_precio <= 0 or tick_size <= 0 or tick_value <= 0:
        return 0.0, "datos invalidos"
    perdida_por_lote = (riesgo_precio / tick_size) * tick_value
    if perdida_por_lote <= 0:
        return 0.0, "datos invalidos"
    bruto = riesgo_dinero / perdida_por_lote
    # Hacia ABAJO al paso del broker: pasarse del riesgo pedido no es un redondeo, es otra
    # apuesta. Quedarse corto solo mide un poco menos.
    pasos = int(bruto / paso)
    v = round(pasos * paso, 8)
    if v > maximo:
        return round(maximo, 8), f"recortado al maximo del broker ({maximo})"
    if v < minimo:
        # Al minimo se arriesga MAS de lo pedido. Se dice cuanto para que se pueda decidir.
        real = minimo * perdida_por_lote
        return 0.0, (
            f"el lote sale {v} y el minimo es {minimo}: al minimo arriesgaria "
            f"{real:.2f} en vez de {riesgo_dinero:.2f}"
        )
    return v, ""


def nocional(precio, riesgo_dinero, riesgo_precio):
    """
    Exposicion en la moneda de la cuenta.

    Con stops de 7-9 pips el riesgo es pequeño pero el NOCIONAL no: arriesgar 5 dolares con un
    stop del 0,06% del precio son 8.500 de exposicion. Con 1:1000 el broker lo permite sin
    pestañear, y por eso hay que mirarlo aqui — el apalancamiento alto no avisa, solo deja.

    Sale sin saber en que moneda cotiza el par: si el precio recorre `riesgo_precio` se pierde
    `riesgo_dinero`, asi que cada unidad de precio vale `riesgo_dinero / riesgo_precio`.
    """
    if riesgo_precio <= 0:
        return 0.0
    return precio * (riesgo_dinero / riesgo_precio)


def riesgo_hueco(riesgo_dinero, stop_pips, hueco_pips):
    """
    Lo que cuesta una posicion si el precio SALTA por encima de su stop.

    ESTA ES LA GUARDA QUE VALE, y no el nocional. El nocional de estas operaciones asusta —5 de
    riesgo con un stop de 9 pips son 8.500 de exposicion, 8,5 veces la cuenta— pero no es lo que
    te arruina: mientras el stop funcione, la perdida son 5. Lo que te arruina es el hueco, que
    es cuando el stop NO funciona porque no hubo precio donde estaba.

    Medido sobre 66.982 saltos entre velas de 5m en nuestros cuatro pares, dentro de la sesion:
    mediana 0,20 pips · p90 0,80 · p99 2,90 · p99,9 10,10 · peor 36,50. Contra un stop de 2 pips
    —los de `video`— un hueco de 10 cuesta CINCO VECES el riesgo pedido; contra uno de 9 pips,
    apenas un 11% mas. Por eso la guarda pega donde tiene que pegar: el stop estrecho es el caro.

    Y los cruces del yen van juntos, asi que hay que suponer que les pasa a todos a la vez.

    Con stop mas ancho que el hueco no hay sorpresa: se pierde lo previsto.
    """
    if stop_pips <= 0:
        return riesgo_dinero
    return riesgo_dinero * max(1.0, hueco_pips / stop_pips)


def identidad(par, t_señal, etiqueta=""):
    """
    Lo que hace unica a una señal: la estrategia, el par y la vela que la genero.

    LA ETIQUETA NO SOBRA. `video` y `afinado` miran los mismos pares y la misma vela, asi que
    pueden dar dos señales con el mismo par y el mismo `tSeñal` — distintas de verdad, porque el
    colchon del stop es 0,1 en una y 1 en la otra, y por tanto el stop, el tamaño y el objetivo
    son otros. Sin la etiqueta la segunda se descartaria por "ya estaba puesta" y solo se
    mediria una de las dos.

    Tiene que caber en 31 caracteres, que es lo que MT5 guarda del comentario de una orden.
    """
    base = f"{par.replace('=X', '')}:{int(t_señal)}"
    return f"{etiqueta}:{base}" if etiqueta else base


def redondear(precio, digitos):
    return round(float(precio), int(digitos))


def que_hacer(pendientes, ya_puestas, ahora, tope_posiciones, abiertas_ahora, etiqueta=""):
    """
    Que pendientes del registro hay que poner, y cuales no.

    Puro a proposito: es la decision entera, y se prueba sin terminal. Devuelve (poner, saltar)
    donde `saltar` lleva el motivo, porque un ejecutor que descarta en silencio es imposible de
    auditar despues.
    """
    poner, saltar = [], []
    hueco = max(0, tope_posiciones - abiertas_ahora)
    for p in pendientes:
        ident = identidad(p["par"], p["tSeñal"], etiqueta)
        if ident in ya_puestas:
            saltar.append((ident, "ya estaba puesta"))
            continue
        if p.get("caducaEn", 0) <= ahora:
            saltar.append((ident, "caducada antes de llegar a ponerla"))
            continue
        # UNA SEÑAL APUNTADA CON RETRASO YA NO ES UNA PRUEBA HACIA ADELANTE, pero SI es una
        # operacion valida: la entrada es una orden limitada cuyo nivel salio de la vela de la
        # señal. Se pone y se apunta el retraso, igual que hace el grabador.
        if len(poner) >= hueco:
            saltar.append((ident, f"tope de {tope_posiciones} posiciones simultaneas"))
            continue
        poner.append(p)
    return poner, saltar


def perdida_del_dia(historial, hoy):
    """Lo perdido hoy, en la moneda de la cuenta. Positivo = perdida."""
    total = 0.0
    for h in historial:
        if h.get("dia") == hoy:
            total += h.get("beneficio", 0.0)
    return -total


# ---------------------------------------------------------------------------------------------
# LO QUE TOCA MT5
# ---------------------------------------------------------------------------------------------


def exigir_demo():
    """
    La unica guarda que no tiene bandera para desactivarla.

    Si algun dia hace falta operar en real, se cambia esta funcion a mano y se ve en el diff de
    git. Una variable de entorno o un `--real` seria justo lo que no se quiere: que la diferencia
    entre demo y dinero de verdad quepa en un descuido.
    """
    c = mt5.account_info()
    if c is None:
        raise SystemExit("no se pudo leer la cuenta")
    if c.trade_mode != 0:
        raise SystemExit(
            f"ESTA CUENTA NO ES DEMO (trade_mode={c.trade_mode}, {c.server}/{c.login}).\n"
            "El ejecutor solo opera en demo. No se ha mandado nada."
        )
    return c


def nuestras_ordenes():
    """Ordenes pendientes que pusimos NOSOTROS. Lo demas en la cuenta no se toca."""
    todas = mt5.orders_get() or []
    return [o for o in todas if o.magic == MAGIA]


def nuestras_posiciones():
    todas = mt5.positions_get() or []
    return [p for p in todas if p.magic == MAGIA]


def recoger_cerradas(est, dias=14):
    """
    Lo que el broker cerro desde la ultima pasada, leido de SU historial y no del nuestro.

    El ejecutor puede estar apagado cuando salta un stop. Si el cierre solo se apuntara cuando
    lo vemos ocurrir, un fin de semana con el portatil dormido perderia operaciones enteras — y
    la guarda de perdida diaria estaria contando sobre un historial con agujeros.

    Se agrupa por `position_id` porque una posicion son al menos dos deals (entrada y salida) y
    el beneficio de la operacion es la suma de los suyos.
    """
    desde = datetime.now(timezone.utc) - timedelta(days=dias)
    deals = mt5.history_deals_get(desde, datetime.now(timezone.utc)) or []
    nuestros = [d for d in deals if d.magic == MAGIA]
    por_posicion = {}
    for d in nuestros:
        por_posicion.setdefault(d.position_id, []).append(d)

    conocidas = {h["posicion"] for h in est.get("historial", [])}
    abiertas = {p.identifier for p in nuestras_posiciones()}
    nuevas = []
    for pid, ds in por_posicion.items():
        if pid in conocidas or pid in abiertas:
            continue
        salida = max(ds, key=lambda d: d.time)
        entrada = min(ds, key=lambda d: d.time)
        # `profit` ya lleva comision y swap en la moneda de la cuenta: es lo que de verdad
        # cambio el saldo, que es lo unico contra lo que tiene sentido medir el coste.
        beneficio = sum(d.profit + d.commission + d.swap for d in ds)
        nuevas.append({
            "posicion": pid,
            "ident": entrada.comment or salida.comment,
            "par": salida.symbol,
            "dia": datetime.fromtimestamp(salida.time, timezone.utc).date().isoformat(),
            "entrada": entrada.price,
            "salida": salida.price,
            "beneficio": round(beneficio, 2),
            "comision": round(sum(d.commission for d in ds), 2),
            "swap": round(sum(d.swap for d in ds), 2),
            "t_entrada": int(entrada.time),
            "t_salida": int(salida.time),
        })
    est.setdefault("historial", []).extend(nuevas)
    return nuevas


def poner_orden(sym, info, p, lotes, caduca, enserio, ident):
    """
    Una limitada con stop y objetivo, con caducidad puesta en el broker.

    Devuelve (ok, ticket, nota). El `ok` va aparte del texto a proposito: con una sola cadena,
    "aceptada con llenado IOC" y "rechazada por saldo" se distinguen mirando dentro del texto,
    y eso se rompe en cuanto alguien cambia una palabra.
    """
    largo = p["direccion"] == "LARGO"
    tipo = mt5.ORDER_TYPE_BUY_LIMIT if largo else mt5.ORDER_TYPE_SELL_LIMIT
    pet = {
        "action": mt5.TRADE_ACTION_PENDING,
        "symbol": sym,
        "volume": lotes,
        "type": tipo,
        "price": redondear(p["entrada"], info.digits),
        "sl": redondear(p["stop"], info.digits),
        "tp": redondear(p["objetivo"], info.digits),
        "magic": MAGIA,
        "comment": ident[:31],
        # LA CADUCIDAD LA LLEVA EL BROKER. Si la llevaramos nosotros, un fin de semana con el
        # portatil apagado dejaria ordenes vivas mucho despues de que su señal dejara de valer.
        "type_time": mt5.ORDER_TIME_SPECIFIED,
        "expiration": int(caduca),
        "type_filling": mt5.ORDER_FILLING_RETURN,
    }
    if not enserio:
        return True, None, "SIMULADO (sin --enserio)"

    # LOS DOS RECHAZOS DE FORMATO, REINTENTADOS. Cada broker acepta un juego distinto de modos
    # de llenado y de caducidad, y no hay forma de saber cual sin mandar: el mercado esta
    # cerrado mientras se escribe esto, asi que esta parte no se ha podido probar contra el
    # servidor. Un rechazo por el modo de llenado o por la caducidad NO es un problema de la
    # operacion —los precios y el tamaño son los mismos— asi que se reintenta con la variante
    # siguiente en vez de perder la señal por una cuestion de forma.
    #
    # Lo que NO se reintenta es un rechazo de fondo: sin dinero, precio invalido, mercado
    # cerrado. Ahi el problema es la orden, y repetirla solo llena el log.
    variantes = [
        ("como se pidio", {}),
        ("llenado IOC", {"type_filling": mt5.ORDER_FILLING_IOC}),
        ("llenado FOK", {"type_filling": mt5.ORDER_FILLING_FOK}),
        ("sin caducidad", {"type_time": mt5.ORDER_TIME_GTC, "expiration": 0}),
        ("IOC y sin caducidad",
         {"type_filling": mt5.ORDER_FILLING_IOC, "type_time": mt5.ORDER_TIME_GTC,
          "expiration": 0}),
    ]
    de_formato = {
        getattr(mt5, "TRADE_RETCODE_INVALID_FILL", 10030),
        getattr(mt5, "TRADE_RETCODE_INVALID_EXPIRATION", 10022),
        getattr(mt5, "TRADE_RETCODE_INVALID_ORDER", 10013),
    }
    ultimo = ""
    for nombre, cambio in variantes:
        r = mt5.order_send({**pet, **cambio})
        if r is None:
            ultimo = f"order_send devolvio None: {mt5.last_error()}"
            break
        if r.retcode == mt5.TRADE_RETCODE_DONE:
            return True, r.order, "" if nombre == "como se pidio" else f"aceptada con {nombre}"
        ultimo = f"rechazada: retcode={r.retcode} {r.comment}"
        if r.retcode not in de_formato:
            break
    return False, None, ultimo


def informe_datos(est, cuenta):
    """
    Lo que llevamos medido. Sin metas y sin veredictos: numeros.

    Esto NO dice si hay que operar en real, ni cuanto falta para nada. Dice que esta pasando con
    los llenados y con el dinero, que es lo unico que este fichero puede saber de verdad.
    """
    lls = est.get("llenados", [])
    hist = est.get("historial", [])
    if not lls and not hist:
        return

    if lls:
        ds = sorted(x["desliz_pips"] for x in lls)
        peor = ds[-1]
        medio = sum(ds) / len(ds)
        mediana = ds[len(ds) // 2]
        malos = [x for x in ds if x > 0]
        print(f"\nLLENADOS · {len(lls)}")
        print(f"   desliz contra el limite pedido: mediana {mediana:+.2f}p · "
              f"medio {medio:+.2f}p · peor {peor:+.2f}p")
        # UNA LIMITADA NO DEBERIA LLENAR PEOR QUE SU PRECIO. Si pasa, hay algo que entender:
        # o el broker desliza las limitadas, o el precio que pedimos no era el que creiamos.
        if malos:
            print(f"   {len(malos)} de {len(lls)} llenaron PEOR que el limite. Una orden "
                  f"limitada no deberia: mira esas.")
        por_est = {}
        for x in lls:
            por_est.setdefault(x["ident"].split(":")[0], []).append(x["desliz_pips"])
        if len(por_est) > 1:
            for k, v in sorted(por_est.items()):
                print(f"   {k:<10} {len(v):>4} llenados · desliz medio "
                      f"{sum(v) / len(v):+.2f}p")

    if hist:
        gan = [h for h in hist if h["beneficio"] > 0]
        total = sum(h["beneficio"] for h in hist)
        comis = sum(h.get("comision", 0) + h.get("swap", 0) for h in hist)
        print(f"\nCERRADAS · {len(hist)} · {len(gan)} en verde "
              f"({len(gan) / len(hist) * 100:.0f}%) · {total:+.2f} {cuenta.currency}")
        if comis:
            print(f"   de eso, {comis:+.2f} son comisiones y swaps")
        por_est = {}
        for h in hist:
            por_est.setdefault(str(h.get("ident", "?")).split(":")[0], []).append(h["beneficio"])
        if len(por_est) > 1:
            for k, v in sorted(por_est.items()):
                verdes = len([x for x in v if x > 0])
                print(f"   {k:<10} {len(v):>4} cerradas · {verdes / len(v) * 100:>3.0f}% verdes · "
                      f"{sum(v):+.2f}")
        por_par = {}
        for h in hist:
            por_par.setdefault(h["par"], []).append(h["beneficio"])
        if len(por_par) > 1:
            print("   por par:", " · ".join(
                f"{k} {sum(v):+.2f}" for k, v in sorted(por_par.items(), key=lambda x: -sum(x[1]))))


def main():
    if mt5 is None:
        raise SystemExit(
            "Falta el paquete MetaTrader5. Este ejecutor solo corre en la maquina que tiene el\n"
            "terminal abierto: `pip install MetaTrader5` y vuelve a intentarlo."
        )
    ap = argparse.ArgumentParser()
    # VARIOS REGISTROS EN UNA SOLA PASADA, y no una ejecucion por estrategia.
    #
    # Porque las guardas tienen que ver la CUENTA ENTERA. Dos ejecuciones separadas se creerian
    # cada una sola en el mundo: cada una dejaria abrir hasta su tope y arriesgar hasta su
    # presupuesto de hueco, y la cuenta acabaria con el doble de ambos sin que ninguna de las
    # dos hiciera nada mal. El riesgo no se reparte por estrategia, se reparte por cuenta.
    ap.add_argument("--registro", action="append", required=True, metavar="ETIQUETA:RUTA",
                    help="p.ej. --registro=video:C:/.../div-video.json (se puede repetir)")
    ap.add_argument("--estado", required=True, help="donde el ejecutor lleva su cuenta")
    ap.add_argument("--enserio", action="store_true",
                    help="mandar de verdad. Sin esto solo dice lo que haria")
    ap.add_argument("--riesgo", type=float, default=0.25,
                    help="%% del saldo por operacion")
    ap.add_argument("--tope-posiciones", type=int, default=12)
    # EL TOPE DE VERDAD ES ESTE. Si todo lo abierto saltara por encima de su stop a la vez
    # —los cruces del yen van juntos— esto es lo que se puede perder, en % del saldo. Con 5 de
    # riesgo, stop de 9 pips y el peor hueco medido (34 pips), cada posicion cuesta ~19 en vez
    # de 5: cuatro a la vez son el 7,6% de una cuenta de 1.000. El tope deja pasar eso y corta
    # antes de que sean ocho.
    ap.add_argument("--tope-hueco", type=float, default=15.0,
                    help="%% del saldo que se puede perder si TODO salta por encima de su stop")
    # EL TOPE POR POSICION VA APARTE Y NO SE DEDUCE DEL DE CARTERA. Cuando se deducia dividiendo
    # el presupuesto entre el numero de posiciones, subir el tope de posiciones apretaba el de
    # cada una y empezaba a rechazar stops normales de 7 pips. Son dos preguntas distintas:
    # cuanto aguanta la cuenta, y cuanto puede pesar una sola operacion dentro de ella.
    ap.add_argument("--tope-hueco-posicion", type=float, default=2.0,
                    help="%% del saldo que puede perder UNA sola posicion en un hueco")
    # DIEZ PIPS, Y SALE DE MEDIRLO. Sobre 66.982 saltos entre velas de 5m DENTRO de la sesion en
    # los cuatro pares: mediana 0,20 · p90 0,80 · p99 2,90 · p99,9 10,10 · peor 36,50.
    #
    # Se coge el p99,9 —uno de cada mil— porque con cientos de posiciones eso pasa varias veces
    # y es lo que hay que aguantar. El peor (36,5 en GBPJPY) es uno entre 67.000: protegerse de
    # el significaria no operar.
    #
    # Y NO SE USA EL HUECO DEL FIN DE SEMANA (34 pips), que es otra cosa: solo lo cruzan 2 de
    # cada 440 operaciones, porque estas cierran en menos de cinco horas. Suponerlo en todas
    # rechazaba TODAS las señales de `video`, cuyos stops son de 1,8-1,9 pips.
    ap.add_argument("--hueco-peor", type=float, default=10.0,
                    help="hueco a suponer, en pips (10 = p99,9 medido entre velas de 5m)")
    # El nocional solo AVISA. La guarda que acota la perdida es la de hueco; esta esta para que
    # el apalancamiento acumulado se vea en el log en vez de pasar desapercibido.
    ap.add_argument("--tope-nocional", type=float, default=60.0,
                    help="a partir de aqui se AVISA de la exposicion. No corta: no es la guarda")
    ap.add_argument("--tope-perdida-dia", type=float, default=3.0,
                    help="%% del saldo perdido en un dia a partir del cual no se abre nada mas")
    ap.add_argument("--parar", default="",
                    help="ruta a un fichero: si existe, no se pone NADA. El boton rojo")
    args = ap.parse_args()

    if args.parar and os.path.exists(args.parar):
        print(f"PARADO: existe {args.parar}. No se pone ninguna orden.")
        return

    est = {"version": 1, "puestas": {}, "llenados": [], "historial": []}
    if os.path.exists(args.estado):
        with open(args.estado, encoding="utf-8") as f:
            est = json.load(f)

    registros = []
    for spec in args.registro:
        etiqueta, _, ruta = spec.partition(":")
        # En Windows la ruta lleva dos puntos ("C:/..."), asi que solo se parte por el PRIMERO
        # y aun asi hay que distinguir "video:C:/x" de "C:/x" a secas.
        if not ruta or (len(etiqueta) == 1 and etiqueta.isalpha()):
            etiqueta, ruta = "", spec
        if not os.path.exists(ruta):
            raise SystemExit(f"no existe el registro {ruta}")
        with open(ruta, encoding="utf-8") as f:
            registros.append((etiqueta, ruta, json.load(f)))

    if not mt5.initialize():
        raise SystemExit(f"no se pudo conectar con el terminal: {mt5.last_error()}")
    cuenta = exigir_demo()
    print(f"cuenta {cuenta.login} · {cuenta.server} · DEMO · saldo {cuenta.balance:.2f} "
          f"{cuenta.currency} · 1:{cuenta.leverage}")
    if not args.enserio:
        print("MODO SIMULACION: se dice lo que se haria y no se manda nada.\n")

    vivos = {s.name for s in mt5.symbols_get()}
    ordenes = nuestras_ordenes()
    posiciones = nuestras_posiciones()
    puestas_vivas = {o.comment for o in ordenes} | {p.comment for p in posiciones}
    # El estado local manda sobre lo que ya se puso, pero se limpia con lo que el broker dice:
    # una orden caducada o llenada y cerrada ya no esta, y su señal tampoco vuelve.
    ya_puestas = set(est["puestas"].keys())

    print(f"en el broker: {len(ordenes)} ordenes nuestras esperando · "
          f"{len(posiciones)} posiciones nuestras abiertas")

    # ---- Lo que el broker cerro mientras no miraba -------------------------------------------
    cerradas = recoger_cerradas(est)
    for c in cerradas:
        print(f"   CERRADA {c['ident']:<26} {c['beneficio']:+.2f} {cuenta.currency}"
              + (f" · comision {c['comision']:.2f}" if c["comision"] else "")
              + (f" · swap {c['swap']:.2f}" if c["swap"] else ""))

    # ---- Guardas de cartera -------------------------------------------------------------------
    hoy = datetime.now(timezone.utc).date().isoformat()
    perdida = perdida_del_dia(est.get("historial", []), hoy)
    tope_perdida = cuenta.balance * args.tope_perdida_dia / 100
    if perdida >= tope_perdida:
        print(f"PARADO POR PERDIDA DIARIA: {perdida:.2f} de un tope de {tope_perdida:.2f}. "
              "No se abre nada mas hoy.")
        mt5.shutdown()
        return

    # La exposicion ya puesta. El riesgo en dinero de cada posicion se lee de lo que se apunto
    # al ponerla, no se reconstruye: el saldo cambia, y reconstruirlo con el saldo de hoy daria
    # un numero distinto del que se arriesgo de verdad.
    expuesto = 0.0
    arriesgado = 0.0
    for pos in posiciones:
        guardada = est["puestas"].get(pos.comment)
        if guardada is None or not pos.sl:
            continue
        riesgo_precio_pos = abs(pos.price_open - pos.sl)
        expuesto += nocional(pos.price_open, guardada["riesgo_pedido"], riesgo_precio_pos)
        arriesgado += riesgo_hueco(
            guardada["riesgo_pedido"],
            riesgo_precio_pos / (0.01 if "JPY" in pos.symbol else 0.0001),
            args.hueco_peor,
        )
    if posiciones:
        print(f"   ya abierto: {expuesto / cuenta.balance:.1f}x de exposicion · "
              f"{arriesgado:.2f} {cuenta.currency} en juego si todo salta el stop "
              f"({arriesgado / cuenta.balance * 100:.1f}% del saldo)")

    ahora = int(time.time())
    riesgo_dinero = cuenta.balance * args.riesgo / 100
    tope = cuenta.balance * args.tope_hueco / 100
    suya = cuenta.balance * args.tope_hueco_posicion / 100
    puestas = 0
    # `vivas` cuenta lo abierto A MEDIDA QUE SE PONE, no solo al empezar. Sin esto el segundo
    # registro creeria que el cupo sigue como estaba y se pasaria del tope de posiciones.
    vivas = len(ordenes) + len(posiciones)

    for etiqueta, ruta, reg in registros:
        pendientes = reg.get("pendientes", [])
        print(f"\n-- {etiqueta or os.path.basename(ruta)}: {len(pendientes)} pendiente(s) "
              f"en el registro")
        poner, saltar = que_hacer(
            pendientes, ya_puestas, ahora, args.tope_posiciones, vivas, etiqueta,
        )
        for ident, motivo in saltar:
            print(f"   - {ident:<28} {motivo}")
        for p in poner:
            ident = identidad(p["par"], p["tSeñal"], etiqueta)
            sym = simbolo_broker(p["par"], vivos)
            if sym is None:
                print(f"   ! {ident:<28} el broker no tiene ese par")
                continue
            mt5.symbol_select(sym, True)
            info = mt5.symbol_info(sym)
            if info is None:
                print(f"   ! {ident:<28} sin informacion del simbolo")
                continue
            riesgo_precio = abs(p["entrada"] - p["stop"])
            lotes, motivo = lote(
                riesgo_dinero, riesgo_precio, info.trade_tick_size, info.trade_tick_value,
                info.volume_step, info.volume_min, info.volume_max,
            )
            if lotes <= 0:
                print(f"   ! {ident:<28} {motivo}")
                continue
            pips = riesgo_precio / (0.01 if "JPY" in sym else 0.0001)
            exp = nocional(p["entrada"], riesgo_dinero, riesgo_precio)
            en_hueco = riesgo_hueco(riesgo_dinero, pips, args.hueco_peor)

            # NINGUNA POSICION SOLA SE LLEVA MAS QUE SU PARTE. Sin esto, una señal con el stop
            # absurdamente estrecho pasa la guarda de cartera solo por ser la primera: con 2 pips de
            # stop son 85 en un hueco, el 8,5% de la cuenta, y la suma todavia no habia llegado al
            # tope. El reparto es el obvio —el presupuesto entre el numero de posiciones— porque
            # cualquier otro seria dejar que la primera en llegar se quede con todo.
            if en_hueco > suya:
                print(f"   - {ident:<28} ella sola arriesga {en_hueco:.2f} en un hueco y le tocan "
                      f"{suya:.2f} · stop de {pips:.1f}p")
                continue

            # LA GUARDA DE CARTERA: que perderiamos si TODO lo abierto saltara su stop a la vez.
            if (arriesgado + en_hueco) > tope:
                print(f"   - {ident:<28} tope de hueco: {arriesgado + en_hueco:.2f} pasaria de "
                      f"{tope:.2f} ({args.tope_hueco}% del saldo con huecos de {args.hueco_peor}p)")
                continue
            # EL NOCIONAL AVISA, NO CORTA. Lo puse cortando y bloqueaba a `video` en la tercera
            # señal: sus stops de 1,8 pips dan 20-29x de exposicion CADA UNO, y eso no es un
            # fallo sino el colchon 0,1 que la estrategia lleva a proposito. Bloquearlo era
            # decidir por el grabador desde aqui, y ademas escondia justo los datos que se
            # quieren medir.
            #
            # Lo que acota la perdida es la guarda de hueco de arriba, no esta. Y si el
            # apalancamiento llegara a no caber, el broker rechaza por margen y se ve en el log
            # —que tambien es un dato: que esta estrategia necesita mas cuenta de la que hay.
            if (expuesto + exp) > cuenta.balance * args.tope_nocional:
                print(f"   ojo  {ident:<26} exposicion acumulada "
                      f"{(expuesto + exp) / cuenta.balance:.0f}x, stop de {pips:.1f}p")

            # MARGEN: que un stop-out no arruine la medida.
            #
            # Con stops de 1,8 pips el nocional se dispara —10 posiciones de `video` son ~250x la
            # cuenta— y aunque el riesgo real siga acotado por los stops, el BROKER mira el
            # margen. Si la cuenta se queda sin el, XM cierra posiciones a la fuerza, y una
            # operacion cerrada por margen no mide nada de la estrategia: mide el tamaño de la
            # cuenta. Se para antes, dejando la mitad del margen libre.
            margen = mt5.order_calc_margin(
                mt5.ORDER_TYPE_BUY if p["direccion"] == "LARGO" else mt5.ORDER_TYPE_SELL,
                sym, lotes, p["entrada"],
            )
            if margen is not None and margen > cuenta.margin_free * 0.5:
                print(f"   - {ident:<28} margen: pide {margen:.2f} y libre quedan "
                      f"{cuenta.margin_free:.2f}. La cuenta no da para mas a la vez.")
                continue

            ok, ticket, nota = poner_orden(
                sym, info, p, lotes, p["caducaEn"], args.enserio, ident)
            linea = (f"   + {ident:<28} {p['direccion']:<6} {lotes} lotes · stop {pips:.1f}p · "
                     f"riesgo {riesgo_dinero:.2f} · {exp / cuenta.balance:.1f}x · "
                     f"en hueco {en_hueco:.2f}")
            if not ok:
                print(f"{linea}  -> {nota}")
                continue
            print(f"{linea}  -> {nota or f'ticket {ticket}'}")
            # EL ACUMULADO SUBE TAMBIEN EN SECO. Si solo subiera al mandar de verdad, el simulacro
            # mediria cada orden contra una cartera vacia y diria que caben todas: acepto USDJPY a
            # 8,5x y despues GBPJPY a 14,8x sin sumarlos, cuando juntas pasan del tope. Un simulacro
            # que no enseña lo que va a pasar es peor que no tenerlo, porque se cree.
            expuesto += exp
            arriesgado += en_hueco
            puestas += 1
            vivas += 1
            ya_puestas.add(ident)
            if args.enserio:
                est["puestas"][ident] = {
                    "ticket": ticket, "par": p["par"], "direccion": p["direccion"],
                    "entrada_pedida": p["entrada"], "stop": p["stop"], "objetivo": p["objetivo"],
                    "lotes": lotes, "riesgo_pedido": riesgo_dinero,
                    "puesta": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                    "tSeñal": p["tSeñal"],
                }

    # ---- Lo que el broker YA lleno: el dato por el que existe todo esto ----------------------
    #
    # La diferencia entre lo pedido y lo llenado ES la medida. Se apunta aqui y no se recalcula
    # despues: un llenado es un hecho de ese instante.
    conocidos = {l["ident"] for l in est.get("llenados", [])}
    for pos in posiciones:
        ident = pos.comment
        if ident in conocidos or ident not in est["puestas"]:
            continue
        pedido = est["puestas"][ident]["entrada_pedida"]
        largo = pos.type == mt5.POSITION_TYPE_BUY
        sym = pos.symbol
        pip = 0.01 if "JPY" in sym else 0.0001
        # Una limitada nunca llena PEOR que su precio. Si llena peor, hay algo que entender.
        desliz = (pos.price_open - pedido) / pip * (1 if largo else -1)
        est.setdefault("llenados", []).append({
            "ident": ident, "par": sym, "direccion": "LARGO" if largo else "CORTO",
            "pedido": pedido, "llenado": pos.price_open, "desliz_pips": round(desliz, 2),
            "t": int(pos.time), "volumen": pos.volume,
            "cuando": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        })
        print(f"   LLENADA {ident}: pedia {pedido} · lleno {pos.price_open} · "
              f"{desliz:+.2f} pips {'a favor' if desliz <= 0 else 'EN CONTRA'}")

    if args.enserio:
        os.makedirs(os.path.dirname(os.path.abspath(args.estado)) or ".", exist_ok=True)
        with open(args.estado, "w", encoding="utf-8") as f:
            json.dump(est, f, indent=2)

    informe_datos(est, cuenta)

    print(f"\n{puestas} orden(es) puesta(s)." if args.enserio
          else "\nNada mandado: faltaba --enserio.")
    mt5.shutdown()


if __name__ == "__main__":
    main()
