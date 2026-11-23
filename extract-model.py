"""Extract just the four regular model files from the known upstream archive."""

import argparse
import shutil
import tarfile
from pathlib import Path, PurePosixPath

MODEL = 'sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8'
FILES = {'encoder.int8.onnx', 'decoder.int8.onnx', 'joiner.int8.onnx', 'tokens.txt'}


def extract_model(archive: Path, destination: Path) -> None:
    destination.mkdir()
    seen = set()
    with tarfile.open(archive, 'r|bz2') as package:
        for member in package:
            path = PurePosixPath(member.name)
            if len(path.parts) != 2 or path.parent.name != MODEL or path.name not in FILES:
                continue
            if not member.isfile() or not (0 < member.size <= 1024**3) or path.name in seen:
                raise ValueError(f'Ungültiger Modelleintrag: {path.name}')
            stream = package.extractfile(member)
            if stream is None:
                raise ValueError('Modelleintrag konnte nicht gelesen werden.')
            with stream, (destination / path.name).open('xb') as target:
                shutil.copyfileobj(stream, target, 1024 * 1024)
            seen.add(path.name)
            if seen == FILES:
                return
    raise ValueError('Modellarchiv ist unvollständig.')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('archive', type=Path)
    parser.add_argument('destination', type=Path)
    args = parser.parse_args()
    try:
        extract_model(args.archive, args.destination)
    except (OSError, ValueError, tarfile.TarError) as error:
        parser.exit(1, f'{error}\n')
