from asyncio.proactor_events import _ProactorBasePipeTransport
import ffmpeg
import tempfile
import os
import glob
import tarfile
from pathlib import Path
import adios2

from girder_client import GirderClient
from flask import Flask, request, Response, send_file, jsonify
from flask_cors import CORS

app = Flask(__name__)

cors_domain = os.environ.get('CORS_DOMAIN', '*')
girder_url = os.environ.get('GIRDER_API_URL', 'http://localhost:8080/api/v1/')

CORS(app, resources={r'/*': {'origins': cors_domain}})

@app.route('/health', methods=['GET'])
def health():
    return jsonify({'status': 'OK'})

cache_settings = {

    'directory': '/tmp/cache',
    'eviction_policy': 'least-frequently-used',
    'size_limit': 2 ** 30, # 1 g
}

def get_girder_client():
    token = request.headers.get('girderToken', '')
    if not token or not id:
        return Response('Invalid token or parameter ID.', status=400)

    gc = GirderClient(apiUrl=girder_url, cacheSettings=cache_settings)
    gc.setToken(token)

    return gc

@app.route('/api/movie/<id>', methods=['GET'])
def create_movie(id):
    gc = get_girder_client()
    with tempfile.TemporaryDirectory() as tmpdir:
        gc.downloadItem(id, tmpdir)
        item_name = os.listdir(tmpdir)[0]
        path_name = os.path.join(tmpdir, item_name, '*.svg')
        if len(glob.glob(path_name)) == 0:
            path_name = os.path.join(tmpdir, item_name, '*.png')
        output_file = tempfile.NamedTemporaryFile(suffix='.mp4')

        try:
            (ffmpeg
                .input(path_name, pattern_type='glob', framerate=10)
                .output(output_file.name)
                .overwrite_output()
                .run())
        except ffmpeg.Error as e:
            raise e

        return send_file(output_file, mimetype='mp4')

def get_timestep_folder_id(gc, group_folder_id):
    return next(gc.listFolder(group_folder_id, parentFolderType='folder', name='timesteps'))['_id']

@app.route('/api/v1/groups/<group_id>/timesteps', methods=['GET'])
def get_timesteps(group_id):
    gc = get_girder_client()

    timestep_items = gc.listItem(get_timestep_folder_id(gc, group_id))

    timesteps = [int(i['name'].split('.')[0]) for i in timestep_items]

    return jsonify(timesteps)





@app.route('/api/v1/groups/<group_id>/variables/<variable_id>/timesteps/<timestep>/plot', methods=['GET'])
def get_timestep_plot(group_id, variable_id, timestep):
    args = request.args

    # Get the format
    format = args['format']

    # Validate format

    if format == 'plotly':
        gc = get_girder_client()

        timestep_folder_id = get_timestep_folder_id(gc, group_id)
        timestep_filename = f"{timestep}.tgz"
        timestep_items = list(gc.listItem(timestep_folder_id, name=timestep_filename))
        if len(timestep_items) != 1:
            return Response('Timestep not found.', status=404)

        timestep_item = timestep_items[0]
        with tempfile.TemporaryDirectory() as tmpdir:
            gc.downloadItem(timestep_item['_id'], tmpdir)
            tar = tarfile.open(Path(tmpdir) / timestep_filename)
            tar.extractall(tmpdir)
            tar.close()

            bp = adios2.open(str(Path(tmpdir) / 'diag1D.0.00011630557404412535.bp'), 'r')

            return jsonify(bp.read('psi_0').tolist())



    elif format == 'vtk':
        pass

    # Fetch the right bp file


    # Extract the meta data
    return ''

if __name__ == '__main__':
    app.run(host='0.0.0.0')
