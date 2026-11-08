"""Read/edit the KV3 v5 DATA of installed sound resources, preserving other blocks.

No game assets are bundled. Unsupported encodings fail before mounting a session.
"""
from __future__ import annotations

import struct
from dataclasses import dataclass

from .entity_lump_kv3 import _decompress_kv3, _compress_kv3, _split_buffer
from .skybox_resources import _resource_blocks
from .panorama_resource import rewrite_panorama_data


@dataclass(eq=True)
class Flagged:
    value: object
    flag: int


def decode(data: bytes):
    if len(data) < 120 or struct.unpack_from('<I', data)[0] != 0x4b563305:
        raise ValueError('Sound resource requires binary KV3 v5')
    method = struct.unpack_from('<I', data, 20)[0]
    c1, c4, c8, ntypes = struct.unpack_from('<4i', data, 28)
    nblobs, blobsize = struct.unpack_from('<2i', data, 56)
    c2 = struct.unpack_from('<i', data, 64)[0]
    u1, z1, u2, z2, b1, b2, b4, b8, _, objects, _, _ = struct.unpack_from('<12i', data, 72)
    if min(c1,c2,c4,c8,ntypes,u1,z1,u2,z2,b1,b2,b4,b8,objects) < 0 or max(u1,u2) > 64*1024*1024:
        raise ValueError('Invalid sound KV3 sizes')
    if nblobs or blobsize or len(data) != 120+z1+z2:
        raise ValueError('Unsupported sound KV3 blobs/trailer')
    a = _decompress_kv3(method,data[120:120+z1],u1)
    b = _decompress_kv3(method,data[120+z1:120+z1+z2],u2)
    aux,_ = _split_buffer(a,count1=c1,count2=c2,count4=c4,count8=c8)
    nstrings = aux.take4()
    strings = []
    for _ in range(nstrings):
        raw = bytes(aux.bytes1); end=raw.find(b'\0')
        if end < 0: raise ValueError('Truncated sound KV3 strings')
        strings.append(raw[:end].decode('utf-8')); aux.bytes1=aux.bytes1[end+1:]
    main,end = _split_buffer(b,count1=b1,count2=b2,count4=b4,count8=b8,start=objects*4)
    if b[end+ntypes:] != b'\x00\xdd\xee\xff':
        raise ValueError('Invalid sound KV3 trailer')
    lengths=iter(struct.unpack_from(f'<{objects}i',b))
    types=iter(b[end:end+ntypes])
    buffers=[main,aux]

    def kind():
        t=next(types)
        return (t&0x3f,next(types)) if t&0x80 else (t,0)

    def read(t=None,flag=0):
        if t is None: t,flag=kind()
        buf=buffers[0]
        if t==1: value=None
        elif t in (13,14): value=t==13
        elif t in (15,16): value=t-15
        elif t in (17,18): value=float(t-17)
        elif t==2: value=bool(buf.take1())
        elif t==23: value=buf.take1()
        elif t in (20,21): value=struct.unpack('<h' if t==20 else '<H',struct.pack('<H',buf.take2()))[0]
        elif t in (11,12): value=buf.take4() if t==11 else buf.take_u32()
        elif t in (3,4,5): value=struct.unpack({3:'<q',4:'<Q',5:'<d'}[t],buf.take8())[0]
        elif t==19: value=struct.unpack('<f',struct.pack('<I',buf.take_u32()))[0]
        elif t==6:
            index=buf.take4(); value='' if index==-1 else strings[index]
        elif t==9:
            value={}
            for _ in range(next(lengths)):
                subtype,subflag=kind(); key=strings[buffers[0].take4()]
                if key in value: raise ValueError('Duplicate sound KV3 key')
                value[key]=read(subtype,subflag)
        elif t==8: value=[read() for _ in range(buf.take4())]
        elif t in (10,24,25):
            count=buf.take4() if t==10 else buf.take1(); subtype,subflag=kind()
            if t==25: buffers.reverse()
            try: value=[read(subtype,subflag) for _ in range(count)]
            finally:
                if t==25: buffers.reverse()
        else: raise ValueError(f'Unsupported sound KV3 type {t}')
        return Flagged(value,flag) if flag else value

    result=read()
    if list(types) or list(lengths) or any(getattr(buf,k) for buf in buffers for k in ('bytes1','bytes2','bytes4','bytes8')):
        raise ValueError('Unread sound KV3 values')
    return result


def encode(value, format_id: bytes) -> bytes:
    """Use ordinary (untyped) arrays and LZ4 v5; preserve resource flags."""
    strings={}; data1=bytearray(); data4=bytearray(); data8=bytearray(); types=bytearray(); objects=[]
    def string(s):
        if s not in strings: strings[s]=len(strings)
        return strings[s]
    def number(n): data4.extend(struct.pack('<i',n))
    def write(v, key=None):
        flag=0
        if isinstance(v,Flagged): v,flag=v.value,v.flag
        if v is None: t=1
        elif isinstance(v,bool): t=13 if v else 14
        elif isinstance(v,str): t=6
        elif isinstance(v,int): t=3 if v<1<<63 else 4
        elif isinstance(v,float): t=5
        elif isinstance(v,dict): t=9
        elif isinstance(v,list): t=8
        else: raise ValueError(f'Unsupported sound value {type(v)}')
        types.append(t|0x80 if flag else t)
        if flag: types.append(flag)
        if key is not None: number(string(key))
        if t==6: number(string(v))
        elif t in (3,4,5): data8.extend(struct.pack({3:'<q',4:'<Q',5:'<d'}[t],v))
        elif t==9:
            objects.append(len(v))
            for k,item in v.items(): write(item,k)
        elif t==8:
            number(len(v))
            for item in v: write(item)
    write(value)
    text=b''.join(s.encode('utf-8')+b'\0' for s in strings)
    buf1=text+b'\0'*((-len(text))%4)+struct.pack('<i',len(strings))
    buf2=bytearray(struct.pack(f'<{len(objects)}i',*objects))
    buf2.extend(data1); buf2.extend(b'\0'*((-len(buf2))%4)); buf2.extend(data4)
    if data8: buf2.extend(b'\0'*((-len(buf2))%8)); buf2.extend(data8)
    buf2.extend(types); buf2.extend(b'\x00\xdd\xee\xff')
    z1=_compress_kv3(1,buf1); z2=_compress_kv3(1,bytes(buf2))
    header=bytearray(120)
    struct.pack_into('<I',header,0,0x4b563305); header[4:20]=format_id
    struct.pack_into('<IHH',header,20,1,0,16384)
    struct.pack_into('<4i',header,28,len(text),1,0,len(types))
    struct.pack_into('<4i',header,48,len(buf1)+len(buf2),len(z1)+len(z2),0,0)
    struct.pack_into('<12i',header,72,len(buf1),len(z1),len(buf2),len(z2),len(data1),0,len(data4)//4,len(data8)//8,0,len(objects),0,0)
    encoded=bytes(header)+z1+z2
    if decode(encoded)!=value: raise ValueError('Sound KV3 round-trip mismatch')
    return encoded


def edit_resource(resource: bytes, transform) -> bytes:
    def edit(data):
        value=decode(data)
        transform(value)
        return encode(value,data[4:20])
    return rewrite_panorama_data(resource,edit)


def read_resource(resource: bytes):
    blocks,_=_resource_blocks(resource); offset,size=blocks['DATA']
    return decode(resource[offset:offset+size])
