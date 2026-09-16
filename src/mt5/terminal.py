r"""
A QUE TERMINAL SE CONECTA CADA SCRIPT, Y CUANTO SE INSISTE.

POR QUE HACE FALTA
------------------
`mt5.initialize()` sin argumentos se engancha al terminal que encuentre, y UN TERMINAL SOLO PUEDE
ESTAR EN UNA CUENTA A LA VEZ. Con dos sistemas distintos -el nuestro y un EA de oro- en dos
cuentas, eso no se sostiene: el 15 sep el terminal paso a la cuenta del oro y nuestra cadena se
quedo 16 horas parada, con 296 rechazos por cuenta equivocada.

La guarda hizo lo correcto —no operar donde no toca— pero el problema no era la guarda: era que
los dos sistemas se peleaban por el mismo terminal.

Con `--terminal` cada cadena abre el SUYO por su ruta, y da igual lo que haga el otro.

Y POR QUE SE INSISTE
--------------------
Porque rendirse al primer intento sale carisimo, y esto ya paso: el 15 sep el ejecutor encadeno
DOCE pasadas seguidas -una hora entera- devolviendo `(-10005, 'IPC timeout')` y sin poner nada.
La cadena salia con codigo 0 y el log tenia una linea. Medido en ese rato, un `initialize()`
suelto conectaba al instante mientras el del ejecutor tardaba 65 segundos y fallaba: el terminal
esta ocupado a ratos —el muestreador de spread lo tiene 3,5 minutos cada quince, y `velas.py`
entra al principio de cada pasada— y quien llega en mal momento se lleva el timeout.

Un sistema cuyo trabajo es mandar ordenes no puede quedarse callado porque la primera llamada
llego tarde. Se reintenta dentro de un presupuesto que cabe en la pasada de cinco minutos, y si
aun asi no entra, se dice cuantas veces se intento.

EL TIMEOUT DE CADA INTENTO ES CORTO A PROPOSITO. Por defecto MT5 espera 60 segundos, que es lo
que hace falta para ARRANCAR un terminal frio. Aqui nunca esta frio: `velas.py` abre el mismo
terminal al principio de cada pasada, asi que cuando llega el ejecutor ya lleva minutos en
marcha. Sesenta segundos parado no compran nada y se comen el presupuesto entero en un intento.

LO QUE ESTO NO HACE
-------------------
No inicia sesion ni toca credenciales. El terminal tiene que estar ya con su cuenta guardada; lo
unico que hace esto es elegir CUAL de los instalados se usa. Si no esta abierto, MT5 lo arranca.
"""
import time

# Cinco intentos de 12 s con 8 s de espera son 92 s en el peor caso, que caben de sobra en una
# pasada de cinco minutos aunque los grabadores se lleven dos minutos antes.
INTENTOS = 5
TIMEOUT_MS = 12_000
ESPERA = 8.0


def conectar(mt5, ruta="", intentos=INTENTOS, timeout_ms=TIMEOUT_MS, espera=ESPERA, dormir=None):
    """
    `mt5.initialize()` apuntando a un terminal concreto. Devuelve el motivo del fallo, o "".

    Se separa en una funcion porque los tres scripts lo hacen igual y porque asi el mensaje de
    error dice QUE terminal se intento abrir y CUANTAS veces, que es lo primero que uno quiere
    saber cuando el log dice que no se puso nada.

    NO BASTA CON QUE `initialize` DIGA QUE SI. Un terminal recien arrancado contesta que si y
    todavia no tiene cuenta: `account_info()` devuelve None y `symbols_get()` una lista parcial.
    Eso ya mordio el 14 sep —el resolutor de simbolos cayo al respaldo y eligio el grupo caro, y
    se rechazaron operaciones por un peaje que era el doble del real—, asi que aqui se exige la
    cuenta antes de dar la conexion por buena. Si no, esperar un intento mas sale gratis.

    `dormir` existe para las pruebas: asi no hay que esperar de verdad.
    """
    dormir = dormir or time.sleep
    ultimo = None
    for i in range(intentos):
        if i:
            dormir(espera)
        ok = mt5.initialize(path=ruta, timeout=timeout_ms) if ruta \
            else mt5.initialize(timeout=timeout_ms)
        if ok and mt5.account_info() is not None:
            return ""
        ultimo = "el terminal contesta pero aun no tiene cuenta" if ok else mt5.last_error()
        # Una conexion a medias se cierra antes de volver a intentarlo: dejarla abierta hace que
        # el siguiente `initialize` crea que ya esta todo hecho y devuelva la misma a medias.
        mt5.shutdown()
    donde = f" ({ruta})" if ruta else ""
    return (f"no se pudo conectar con el terminal{donde} en {intentos} intentos "
            f"de {timeout_ms / 1000:.0f}s: {ultimo}")
